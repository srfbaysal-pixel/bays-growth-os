# Test raporu

Tarih: 2026-10-30 · Ortam: geliştirme konteyneri (Node 22.22, PostgreSQL 16.15 yerel, Chromium/Playwright). Gerçek API anahtarı **kullanılmadı**; tüm dış sağlayıcılar mock.

## Komutlar ve sonuçlar

| Komut | Sonuç |
| --- | --- |
| `npm --prefix apps/api run typecheck` | Hata yok |
| `npm --prefix apps/panel run typecheck` | Hata yok |
| `npm --prefix apps/api test` (vitest, gerçek PostgreSQL `bays_acq_test`) | **79/79 geçti**, 10 dosya, ~8 sn (17'si denetim düzeltmeleri: `tests/hardening.test.ts`) |
| `npm --prefix apps/panel test` (vitest) | **2/2 geçti** |
| `npm --prefix apps/panel run build` (Next 15, standalone) | Başarılı; ilk yük JS ~103–111 kB |
| `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm --prefix apps/panel run test:e2e` | **10/10 geçti** (5 senaryo × Pixel 7 + masaüstü), ~15 sn; API + panel otomatik başlatıldı |
| `node tools/validate-n8n.mjs` | 3/3 workflow OK (13 / 20 / 22 düğüm) |

## Kabul kriterleri eşlemesi

| Kriter (şartname §12) | Test | Durum |
| --- | --- | --- |
| Lead keşfi ve mükerrer kayıt engelleme | `discovery.test.ts` (ad/alan adı/telefon/place id birleşimi, unique ihlali), `workflows.test.ts` WF1 tekrar çalıştırma → 0 yeni kayıt | ✅ |
| Sektörel puanlama | `scoring.test.ts` (ağırlıklar, gözlem ≠ çıkarım, `inference_ok` kapısı, 0/100 sınırları, hizmet önerisi) | ✅ |
| Yanlış kişiselleştirme engelleme | `drafts.test.ts` (yanlış işletme adı, yer tutucu, fiyat, yasak iddia, sahte kanıt kimliği, ret ifadesi yokluğu, klinik sağlık verisi; AI taslağı reddedilince şablona düşüş; çıkarımların taslağa girmemesi) | ✅ |
| İnsan onayı olmadan gönderim yapılamaması | `sender.test.ts` "onaysız taslak asla gönderilmez", "reddedilen taslak kuyruğa girmez"; `workflows.test.ts` WF2 send picked=0 | ✅ |
| Ret listesinin uygulanması | `sender.test.ts` (onay sonrası engelleme → send-time block; tüm kanallarda opt_out), `inbound.test.ts` (ret yanıtı → suppressions + deal lost), `policy.test.ts` | ✅ |
| Gönderim hatası ve retry güvenliği | `sender.test.ts` (retry + backoff, bekleme dolmadan alınmaz, tek sağlayıcı çağrısı, max deneme → failed, kota → kuyruğa geri, ardışık hata → kill-switch) | ✅ |
| E-posta yanıtının doğru işletmeyle eşleşmesi | `inbound.test.ts` (reply+token, Message-ID, kişi e-postası, eşleşmeyen → inceleme görevi, mükerrer teslim, bounce) | ✅ |
| Mobil panelin temel işlevleri | `e2e/panel.spec.ts` Pixel 7 projesi: giriş, alt gezinme, 6 sayfa, lead detayı, onay akışı, PWA manifest/SW/ikon | ✅ |
| Kimlik doğrulama ve yetki kontrolleri | `http.test.ts` (401, hatalı parola + audit, viewer 403, operator/owner ayrımı, CSRF Origin, çıkış, login rate limit, n8n HMAC: imzasız/yanlış/eski/panel oturumu → 401), e2e viewer senaryosu | ✅ |
| Workflow hata ve durdurma senaryoları | `workflows.test.ts` (kaynak hatası → `partial`, bilinmeyen sektör → `failed`), `http.test.ts` heartbeat failed, `sender.test.ts` kill-switch, `http.test.ts` run_id idempotency | ✅ |
| Webhook imza doğrulaması | `http.test.ts` WhatsApp GET doğrulama + X-Hub-Signature-256; Resend kapalıysa 404 | ✅ |
| K1 veritabanı kimliği | `hardening.test.ts` (yanlış ad durur, n8n adı her durumda durur, resetDatabase koruması) | ✅ |
| K3 DRY_RUN ayrımı | `hardening.test.ts` (dry_run durumu, işletme değişmez, yeniden taslak, idempotency) | ✅ |
| K4 bounce/DSN | `hardening.test.ts` (Message-ID/alıcı ile eşleşme, eşleşmeyen → engelleme + görev, kill-switch sayımı, gönderen engellenmez) | ✅ |
| Ö1 iç uç ağ katmanı | `hardening.test.ts` (dış IP geçerli imzayla 403, sahte X-Forwarded-For yok sayılır, özel liste) | ✅ |
| Ö2 SSRF | `hardening.test.ts` (şema/port/localhost/özel DNS/mapped IPv6, yönlendirme kaçışı, döngü sınırı, istek atılmaz) | ✅ |
| Ö8 bildirim | `hardening.test.ts` (tek bildirim, imza doğrulaması, görev + audit, webhook yok/hata durumunda akış sürer) | ✅ |
| K2/Ö9 dağıtım dosyaları | `hardening.test.ts` (.dockerignore, log rotasyonu, loopback portlar, Caddy 403, betikler) | ✅ |
| Referans kampanyası | `workflows.test.ts` (durum makinesi, paylaşım doğrulaması → indirim hakkı, klinikte mevzuat engeli) | ✅ |
| E-posta DNS ön kontrol | `workflows.test.ts` enjekte çözümleyici ile SPF/DKIM/DMARC/MX | ✅ |

## Test edilmeyenler (gerçek ortam gerektirir)

**K5 — açık dağıtım kabul kriteri:** SMTP/Resend gerçek teslimat, DKIM/SPF/DMARC "pass", IMAP ile gerçek yanıt ve bounce turu bu ortamda doğrulanmadı · Google Places gerçek yanıtı · Anthropic gerçek çıktı kalitesi · n8n'e import ve `$env`/Crypto düğümü davranışı (yapısal kontrol yapıldı) · Docker build (daemon yok) · Caddy üzerinde HTTPS · Android cihazda "Ana ekrana ekle".

Testleri tekrarlamak için: `DATABASE_URL_TEST=postgres://bays_acq:<parola>@127.0.0.1:5432/bays_acq_test npm test` (test DB adı `test` içermeli; her dosya şemayı sıfırlar).
