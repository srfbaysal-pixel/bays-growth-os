# IMPLEMENTATION_STATUS — BaysSystems Customer Acquisition Engine V1

Son güncelleme: 2026-10-30. Durum: **geliştirme teslimi, test modunda kurulabilir.** Üretim ortamına geçiş ayrı onaya ve aşağıdaki "gerçek ortamda doğrulanacaklar" listesine bağlıdır.

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

API 62/62 (gerçek PostgreSQL), panel birim 2/2, Playwright e2e 10/10 (mobil + masaüstü), n8n yapısal doğrulama 3/3, tip kontrolü ve üretim derlemesi. Ayrıntı: `docs/TEST_REPORT.md`.

## Eksik bağlantılar / bilinçli sınırlamalar

- WhatsApp **gönderim** adaptörü yok (yalnız webhook alma). Opt-in + onaylı şablon politikası ve İYS doğrulaması sağlanmadan eklenmeyecek.
- Instagram/LinkedIn otomasyonu yok (politika gereği); panel manuel görev üretir.
- Otomatik video üretim motoru yok; referans kampanyası manuel video yükleme ile çalışır (`video_url`).
- Panelde işletme birleştirme (merge) arayüzü yok; mükerrer önleme keşif aşamasında otomatik.
- Haftalık rapor bildirimi (e-posta/WhatsApp) n8n'de `noOp` düğümü olarak bırakıldı; kullanıcı kendi kanalını bağlar.
- Panel oturumu tek cihaz/çok cihaz ayrımı yapmaz; parola sıfırlama akışı yok (CLI `create-user` ile parola yenilenir).
- Next.js `rewrites` hedefi derleme zamanında okunur (`API_INTERNAL_URL`); üretimde Caddy doğrudan yönlendirdiği için sorun değildir.

## Gerçek ortamda doğrulanması gerekenler (sırayla)

1. Sunucu kaynakları (`deploy/scripts/preflight.sh`), ayrı `bays_acq` DB oluşturma, `seed`.
2. Caddy bloğu + HTTPS; panel girişi; Android'de "Ana ekrana ekle".
3. n8n: ortam değişkenleri, 3 workflow import, Crypto düğümü `$env` erişimi (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`), WF1 manuel çalıştırma → Sistem sayfasında `wf1_discovery`.
4. Google Places gerçek sonuçları ve maliyet (günlük limit); Places politikası (30 gün önbellek).
5. Anthropic taslak kalitesi; doğrulama uyarı oranı.
6. E-posta protokolü (`docs/EMAIL_DELIVERABILITY.md`): preflight, kuru çalışma, test alıcısı, yanıt turu, bounce turu; SPF/DKIM/DMARC `pass`.
7. IMAP: `reply+token@` adreslerinin kutuya düşmesi; WF3 eşleşme oranı.
8. Hukuki doğrulama: İYS/KVKK (ve klinik mevzuatı) → `COMPLIANCE_*` bayrakları. Bu adım olmadan gerçek alıcılara otomatik gönderim **yapılmaz**.
9. Docker build (bu ortamda daemon yoktu) veya systemd yolu.
10. Fiyat planlarının panelden girilmesi (seed değerleri yer tutucu).

## Varsayımlar

- Pilot şehirler İstanbul/Ankara/İzmir (n8n `BAYS_PILOT_CITIES` ile değişir); hedef sektör başına 30 nitelikli.
- Nitelik eşiği sektör dosyasında (45/45/50); pilot verisiyle ayarlanmalı.
- Yanıt kutusu `EMAIL_REPLY_DOMAIN` altında plus-addressing/catch-all destekler.
- Mevcut Postgres 16 ve n8n'in HTTP Request (v4.2), Crypto (v1), Code (v2), Schedule Trigger (v1.2), IMAP (v2), IF (v2.2), Set (v3.4), Split In Batches (v3) düğüm sürümlerini desteklediği (n8n ≥ 1.20) varsayıldı; eski sürümde import sırasında düğüm sürümü uyarısı alınabilir.
