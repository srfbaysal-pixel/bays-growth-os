# IMPLEMENTATION_STATUS — BaysSystems Customer Acquisition Engine V1

Son güncelleme: 2026-10-30 (denetim düzeltmeleri sonrası). Durum: **geliştirme teslimi, test modunda kurulabilir.** Üretim ortamına geçiş ayrı onaya ve aşağıdaki "gerçek ortamda doğrulanacaklar" listesine bağlıdır.

## Denetim düzeltmeleri (teknik denetim raporu, kabul edilen maddeler)

| Madde | Düzeltme | Dosyalar | Test |
| --- | --- | --- | --- |
| K1 | Migration, seed, CLI ve API açılışı hedef veritabanı adını doğrular (`EXPECTED_DB_NAME`); adı `n8n` içeren DB'de geçersiz kılma olmadan durur | `apps/api/src/db/migrate.ts`, `apps/api/src/cli.ts`, `apps/api/src/index.ts`, `apps/api/src/config.ts` | `tests/hardening.test.ts` K1 |
| K2 | `.dockerignore`; bellek/swap kontrollü sıralı derleme ve dışa aktarma betiği; `preflight.sh` RAM/swap uyarıları | `.dockerignore`, `deploy/scripts/build-images.sh`, `deploy/scripts/preflight.sh` | `tests/hardening.test.ts` dağıtım dosyaları |
| K3 | DRY_RUN artık taslağı `dry_run` durumuna alır, işletme durumunu ve `sent_at` alanını değiştirmez; WF2 bu işletmeleri yeniden aday sayar ve yeni sıra numarasıyla gerçek taslak hazırlar; `purge-dry-run` CLI komutu | `db/migrations/0003_dry_run_status.sql`, `apps/api/src/outreach/sender.ts`, `apps/api/src/outreach/drafts.ts`, `apps/api/src/workflows/wf2.ts`, `apps/api/src/cli.ts` | `tests/hardening.test.ts` K3, `tests/sender.test.ts` |
| K4 | DSN/bounce postalarından `Final-Recipient`/Message-ID çıkarılır; In-Reply-To olmadan gönderim işine eşleşir; eşleşmeyen bounce alıcıyı engeller, inceleme görevi açar, kill-switch bounce oranına dahil edilir; gönderen (MAILER-DAEMON) asla engellenmez | `apps/api/src/inbound/bounce.ts`, `apps/api/src/inbound/process.ts`, `apps/api/src/outreach/killswitch.ts` | `tests/hardening.test.ts` K4 |
| Ö1 | `/internal/*` iki katman: ağ (`INTERNAL_ALLOWED_IPS`, varsayılan loopback + özel ağlar; Caddy'de `remote_ip private_ranges`, diğerleri 403) + HMAC; `trustProxy` yalnız loopback/özel ağ proxy'leri | `apps/api/src/http/plugins.ts`, `apps/api/src/http/server.ts`, `apps/api/src/lib/ip.ts`, `deploy/Caddyfile.snippet`, `docker-compose.yml` | `tests/hardening.test.ts` Ö1 |
| Ö2 | Web tarayıcısında SSRF koruması: şema/port/kullanıcı bilgisi kontrolü, DNS çözümünde tüm adresler özel ağ taraması, yönlendirmeler elle izlenir ve her atlama yeniden doğrulanır | `apps/api/src/discovery/website.ts`, `apps/api/src/lib/ip.ts` | `tests/hardening.test.ts` Ö2 |
| Ö8 | Kill-switch durum değişiminde yönetici bildirimi: panel görevi + audit + (varsa) `ALERT_WEBHOOK_URL`'e imzalı POST | `apps/api/src/health/notify.ts`, `apps/api/src/outreach/killswitch.ts` | `tests/hardening.test.ts` Ö8 |
| Ö9 | Docker log rotasyonu (json-file 3 × 10 MB) tüm servislerde | `docker-compose.yml` | `tests/hardening.test.ts` dağıtım dosyaları |

**K5 (gerçek SMTP/IMAP) bu ortamda doğrulanmadı ve açık dağıtım kabul kriteridir:** `docs/EMAIL_DELIVERABILITY.md` test protokolünün 2–6. adımları gerçek hesapla geçmeden canlı gönderim açılmaz.

## Tamamlananlar

- [x] PostgreSQL şeması (`db/migrations/0001_init.sql`): işletme/kişi, kaynak/kanıt (gözlem ≠ çıkarım), puan geçmişi, kanal izinleri, engelleme, taslak/onay, gönderim işi/olayı, kota, gelen yanıt, fırsat/görev/teklif/abonelik, referans kampanyası, audit, workflow çalışmaları, bayraklar, webhook olayları, günlük metrik; unique kısıtlar, indeksler, migration çalıştırıcı.
- [x] Sektör bağımsız yapılandırma: `config/sectors/{education,beauty,clinic}.json` (sinyal ağırlıkları, eşik, hizmet tercihi, mesaj açıları, uyumluluk); yeni sektör = yeni JSON.
- [x] Hizmet kataloğu `config/services.json` (5 hizmet); fiyatlar DB `price_plans` tablosunda, panelden (owner) düzenlenir; seed yer tutucu 0 ₺ planları ekler ve 0 ₺ planla teklif **engellenir**.
- [x] WF1: keşif adaptörleri (Google Places New, mock, CSV), web sitesi gözlemi (robots.txt), normalize + mükerrer önleme, AI çıkarımı (ayrı kayıt), kural tabanlı puanlama, kanal izni başlangıç kaydı.
- [x] WF2: hizmet önerisi, yalnız doğrulanmış kanıta dayalı taslak (AI veya şablon), deterministik doğrulayıcı, kanal politikası (Instagram/LinkedIn asla otomatik; WhatsApp opt-in+şablon; e-posta uyumluluk kapıları; test alıcıları), onay kuyruğu, onay/ret/düzenleme, manuel görev, gönderim kuyruğu (kilit, idempotency, retry, kota, kill-switch, DRY_RUN).
- [x] WF3: IMAP/webhook yanıt işleme (reply+token, Message-ID, kişi, alan adı eşleştirme), sınıflandırma (kurallar + AI), ret → tüm kanallarda engelleme, fırsat/görev üretimi, teklif/abonelik durumları, referans kampanyası durum makinesi, günlük/haftalık metrik.
- [x] E-posta: SMTP/Resend/mock adaptörleri, Reply-To token, List-Unsubscribe, teslimat/bounce/şikâyet olayları (Resend svix webhook, genel olay ucu), DNS ön kontrol (SPF/DKIM/DMARC/MX/hizalama), kota ve kill-switch.
- [x] Panel (Next.js 15 PWA, Türkçe, mobil öncelikli): Özet, Leadler (+detay), Onaylar (onay/ret/düzenle), Satış (yanıtlar, görevler, fırsatlar, teklifler, manuel yanıt girişi), Gelir (MRR, sektör, abonelikler, referans kampanyası), Sistem (mod, kill-switch, e-posta ön kontrol, workflow durumu, kuyruk, entegrasyonlar, hatalar). Manifest + service worker + ikonlar; sahte metrik yok.
- [x] Güvenlik: scrypt parola, httpOnly oturum, rol kontrolü sunucuda, rate limit, CSRF Origin kontrolü, HMAC imzalı iç uçlar (zaman penceresi), webhook imzaları, zod doğrulama, parametreli SQL, CSP/başlıklar, audit log, sır maskeli log, yedek/geri yükleme betikleri.
- [x] n8n: 3 workflow JSON (üretici + yapısal doğrulayıcı), hata → heartbeat, run_id idempotency.
- [x] Dağıtım: Docker Compose (bellek limitleri, isteğe bağlı ayrı PG), Dockerfile'lar, Caddy bloğu, systemd birimleri, backup/restore/preflight betikleri.
- [x] Dokümanlar: mimari, kurulum/deployment, e-posta teslim edilebilirliği, entegrasyon listesi, uyumluluk, hata giderme/rollback, test raporu.

## Test edilenler

API 79/79 (gerçek PostgreSQL), panel birim 2/2, Playwright e2e 10/10 (mobil + masaüstü), n8n yapısal doğrulama 3/3, tip kontrolü ve üretim derlemesi. Ayrıntı: `docs/TEST_REPORT.md`.

## Eksik bağlantılar / bilinçli sınırlamalar

- WhatsApp **gönderim** adaptörü yok (yalnız webhook alma). Opt-in + onaylı şablon politikası ve İYS doğrulaması sağlanmadan eklenmeyecek.
- Instagram/LinkedIn otomasyonu yok (politika gereği); panel manuel görev üretir.
- Otomatik video üretim motoru yok; referans kampanyası manuel video yükleme ile çalışır (`video_url`).
- Panelde işletme birleştirme (merge) arayüzü yok; mükerrer önleme keşif aşamasında otomatik.
- Haftalık rapor bildirimi (e-posta/WhatsApp) n8n'de `noOp` düğümü olarak bırakıldı; kullanıcı kendi kanalını bağlar.
- Panel oturumu tek cihaz/çok cihaz ayrımı yapmaz; parola sıfırlama akışı yok (CLI `create-user` ile parola yenilenir).
- Next.js `rewrites` hedefi derleme zamanında okunur (`API_INTERNAL_URL`); üretimde Caddy doğrudan yönlendirdiği için sorun değildir.
- Denetimden kalan açık kalemler (kod değişikliği yapılmadı): Ö3 kısmen (trustProxy daraltıldı), Ö4 hesap kilitleme, Ö5 saklama süresi, Ö6/Ö7 n8n sürüm ve zaman aşımı, Ö10 yedek cron, Ö12 test kutusu, Ö13 systemd standalone kopyası, Ö14 Next 16, Ö15 saat dilimi; S1–S9.

## Gerçek ortamda doğrulanması gerekenler (sırayla)

1. Sunucu kaynakları (`deploy/scripts/preflight.sh`), ayrı `bays_acq` DB oluşturma, `seed`.
2. Caddy bloğu + HTTPS; panel girişi; Android'de "Ana ekrana ekle".
3. n8n: ortam değişkenleri, 3 workflow import, Crypto düğümü `$env` erişimi (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`), WF1 manuel çalıştırma → Sistem sayfasında `wf1_discovery`.
4. Google Places gerçek sonuçları ve maliyet (günlük limit); Places politikası (30 gün önbellek).
5. Anthropic taslak kalitesi; doğrulama uyarı oranı.
6. E-posta protokolü (`docs/EMAIL_DELIVERABILITY.md`): preflight, kuru çalışma, test alıcısı, yanıt turu, bounce turu; SPF/DKIM/DMARC `pass`.
7. IMAP: `reply+token@` adreslerinin kutuya düşmesi; WF3 eşleşme oranı.
8. Hukuki doğrulama: İYS/KVKK (ve klinik mevzuatı) → `COMPLIANCE_*` bayrakları. Bu adım olmadan gerçek alıcılara otomatik gönderim **yapılmaz**.
9. Docker build (bu ortamda daemon yoktu; `deploy/scripts/build-images.sh` ile sunucu dışında derleyip taşımak önerilir) veya systemd yolu.
10. Fiyat planlarının panelden girilmesi (seed değerleri yer tutucu).

## Varsayımlar

- Pilot şehirler İstanbul/Ankara/İzmir (n8n `BAYS_PILOT_CITIES` ile değişir); hedef sektör başına 30 nitelikli.
- Nitelik eşiği sektör dosyasında (45/45/50); pilot verisiyle ayarlanmalı.
- Yanıt kutusu `EMAIL_REPLY_DOMAIN` altında plus-addressing/catch-all destekler.
- Mevcut Postgres 16 ve n8n'in HTTP Request (v4.2), Crypto (v1), Code (v2), Schedule Trigger (v1.2), IMAP (v2), IF (v2.2), Set (v3.4), Split In Batches (v3) düğüm sürümlerini desteklediği (n8n ≥ 1.20) varsayıldı; eski sürümde import sırasında düğüm sürümü uyarısı alınabilir.
