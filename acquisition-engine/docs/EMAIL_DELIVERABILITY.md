# E-posta güvenilirliği — kontrol listesi ve canlıya geçiş kapıları

Geçmişte gönderim sorunu yaşandığı için e-posta modülü "çalıştığı varsayılmadan" tasarlandı. Her gönderim bir **iş** (`send_jobs`) ve bir dizi **olay** (`send_events`: queued → attempt → accepted/dry_run/error → delivered/bounce/complaint/replied) olarak kaydedilir.

## Koruma mekanizmaları (kodda)

| Mekanizma | Yer | Davranış |
| --- | --- | --- |
| DRY_RUN | `config.ts`, `sender.ts` | Sağlayıcıya istek atılmaz; iş ve taslak `dry_run` durumuna geçer, `sent_at` boş kalır, işletme durumu değişmez; aynı işletme için sonradan gerçek taslak hazırlanır. `LIVE_OUTREACH_ENABLED` DRY_RUN açıkken etkisizdir. |
| Test alıcıları | `policy.ts` | Test modunda yalnız `TEST_RECIPIENTS` listesindekilere otomatik gönderim; diğerleri manuel görev. |
| Uyumluluk kapıları | `policy.ts` | `COMPLIANCE_IYS_VERIFIED`, `COMPLIANCE_KVKK_VERIFIED` (+ klinik) false iken otomatik gönderim yok. |
| İnsan onayı | `approvals.ts` | `send_jobs` kaydı yalnız `approveDraft` ile oluşur; `draft_id` UNIQUE. |
| İdempotency | `sender.ts` | `FOR UPDATE SKIP LOCKED` kilidi; iş kimliği `Idempotency-Key`/`X-Bays-Idempotency` başlığı; `accepted` sonrası ikinci istek yok. |
| Retry | `sender.ts` | 3 deneme, 2/10/30 dk bekleme; sonra `failed`. Deneme sayısı DB'de. |
| Kota | `killswitch.ts`, `sender.ts` | Saatlik/günlük sayaç atomik ve yalnız **gerçek** gönderim denemesinde artar (dry-run tüketmez, D6); aşımda iş kuyruğa geri döner (1 saat). |
| Kill-switch | `killswitch.ts`, `health/notify.ts` | Bounce oranı > `EMAIL_MAX_BOUNCE_RATE` (≥10 tekil gönderim), ardışık hata ≥ `EMAIL_MAX_CONSECUTIVE_ERRORS`, günlük kota dolu → `outreach_paused`. Durum değişiminde panel görevi + audit + `ALERT_WEBHOOK_URL` bildirimi. Panelden sürdürülür. |

### Bounce oranı semantiği (D6)

Son 24 saat, yalnız gerçek gönderimler (dry-run hariç):

| Terim | Tanım |
| --- | --- |
| `sent24h` | sağlayıcıya ulaşan **tekil** gönderim işi (`accepted` veya `reject` olayı olan işler) |
| `bounced24h` | bunlardan `bounce` / `complaint` / `reject` olayı olan **tekil** iş; `accepted→delivered` ikinci kez saymaz, aynı işe yinelenen bounce bir kez sayılır |
| `unmatchedBounces24h` | hiçbir işe eşleşmeyen DSN postaları (K4); ayrı raporlanır |
| `bounceRate` | `(bounced24h + unmatchedBounces24h) / sent24h` — eşleşmeyen DSN'ler muhafazakâr olarak paya eklenir |

Örnek: 100 tekil kabul edilen mesajdan 5'i bounce → %5 (eşik `0.05` ile **durmaz**, kural `>`); 6. tekil bounce veya 1 eşleşmeyen DSN → %6 → durur. `sent24h < 10` iken oran değerlendirilmez. `bounce` = alıcı sunucu teslim edemedi, `complaint` = spam bildirimi, `reject` = sağlayıcı kabul etmedi; üçü de alıcıyı engelleme listesine alır.
| Bounce/şikâyet | `recordDeliveryEvent`, `inbound/process.ts`, `inbound/bounce.ts` | Sağlayıcı webhook'u veya gelen DSN postası: `Final-Recipient`/gövdedeki Message-ID ile iş bulunur, alıcı engellenir, iş `bounced`. Eşleşmeyen DSN'de de alıcı engellenir ve inceleme görevi açılır; bu postalar kill-switch bounce oranına dahildir. Gönderen (MAILER-DAEMON) engellenmez. |
| Ret | `inbound/process.ts` | "hayır/istemiyorum/unsubscribe" → işletme + e-posta + alan adı + telefon + Instagram tüm kanallarda engellenir. |
| Yanıt eşleştirme | `inbound/process.ts` | `Reply-To: reply+<token>@EMAIL_REPLY_DOMAIN` ve `Message-ID: <job_id@domain>`; yedek: kişi e-postası, alan adı. |
| List-Unsubscribe | `smtp.ts` | Her gönderimde `List-Unsubscribe` başlığı. |

## DNS ve gönderici hizalaması (canlı öncesi)

Komut: `npm --prefix apps/api run email:preflight` veya panel → Sistem → **E-posta ön kontrol**.

| Kontrol | Beklenen |
| --- | --- |
| SPF | `EMAIL_FROM_ADDRESS` alan adında `v=spf1 ... -all` (veya `~all`), **`+all` yok**; sağlayıcının `include:` kaydı var. |
| DKIM | Sağlayıcının verdiği seçici (`<selector>._domainkey.<domain>`) TXT kaydı yayınlanmış; ön kontrol yaygın seçicileri dener, bulamazsa elle doğrulayın. |
| DMARC | `_dmarc.<domain>` → `v=DMARC1; p=quarantine` (en az `p=none` + `rua=` ile izleme, sonra sıkılaştırma). |
| Hizalama | From alanı = DKIM `d=` alanı = SPF alanı (gönderici hizalaması). `EMAIL_REPLY_DOMAIN` From alanıyla aynı/alt alan olmalı. |
| MX (yanıt alanı) | `EMAIL_REPLY_DOMAIN` için MX var ve `reply+*@` adresleri IMAP kutusuna düşüyor (catch-all veya plus-addressing). |
| rDNS/PTR | SMTP kendi sunucunuzdan çıkıyorsa PTR kaydı gönderici ana makine adıyla eşleşmeli. |

## Sağlayıcı politikası

- **SMTP (mevcut hesap):** sağlayıcının günlük/saatlik gönderim sınırlarını `EMAIL_DAILY_QUOTA` / `EMAIL_HOURLY_QUOTA` değerlerine **altında kalacak şekilde** girin. Soğuk e-postaya izin vermeyen sağlayıcılar (çoğu kurumsal posta) için yalnız yanıt/takip kullanın.
- **Resend:** API anahtarı + domain doğrulaması + webhook (`RESEND_WEBHOOK_SECRET`) ile delivered/bounced/complained olayları otomatik işlenir.
- Günlük hacmi düşük başlatın (pilot: 10–20/gün), bounce oranı %2 üstünde durup listeyi temizleyin.

## Test protokolü (sırayla, her biri raporlanır)

> **Dağıtım kabul kriteri (K5):** 2–6. adımlar gerçek SMTP/IMAP hesabıyla bu ortamda **doğrulanmadı**. Bu adımlar sizin hesabınızla geçip sonuçları `IMPLEMENTATION_STATUS.md`'ye işlenmeden canlı gönderim açılmaz.

1. **Mock:** `npm run test:api` — gönderim, retry, kill-switch, mükerrer önleme testleri geçmeli.
2. **Bağlantı:** `EMAIL_PROVIDER=smtp` + bilgiler → `email:preflight` → `provider.verify OK`.
3. **Kuru çalışma:** DRY_RUN=true ile WF2 send → `dry_run` olayı, Sistem sayfasında kuyruk `dry_run: n`.
4. **Test alıcısı:** `DRY_RUN=false`, `LIVE_OUTREACH_ENABLED=true`, `TEST_RECIPIENTS=kendi@adresiniz` → kendi adresinize onaylı bir taslak gönderin. Beklenen: `accepted` olayı; gelen kutusunda **Reply-To `reply+...`**, DKIM `pass`, SPF `pass`, DMARC `pass` (Gmail "Orijinali göster").
5. **Yanıt turu:** Test e-postasına "ilgileniyorum" diye yanıt verin → WF3 IMAP → panel Satış → Yanıtlar'da `interested`, eşleşme `reply_token`. Sonra "hayır" → `rejected` ve engelleme.
6. **Bounce turu:** Var olmayan bir adrese (kendi alan adınızda) test gönderimi → bounce → engelleme listesi.
7. Tüm turlar geçmeden `COMPLIANCE_*` bayrakları açılmaz; açılınca gerçek alıcılara gönderim başlar.

## Otomatik soğuk e-posta

Varsayılan **kapalı**. Açmak üç bağımsız koşul ister: DRY_RUN=false, LIVE_OUTREACH_ENABLED=true, COMPLIANCE_IYS_VERIFIED=true+COMPLIANCE_KVKK_VERIFIED=true. Üstüne her mesaj için panelde insan onayı gerekir.
