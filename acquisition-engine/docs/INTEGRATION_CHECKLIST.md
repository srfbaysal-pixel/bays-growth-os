# Entegrasyon kontrol listesi

Durum anahtarı: ✅ kodlandı + mock testli · 🔌 kodlandı, gerçek hesapla doğrulanmadı · ⛔ bilinçli olarak yapılmadı

| Entegrasyon | Durum | Gereken | Doğrulama adımı |
| --- | --- | --- | --- |
| PostgreSQL 16 | ✅ | `DATABASE_URL` (ayrı `bays_acq` DB) | `npm run migrate` → "Şema güncel"; testler gerçek PG ile geçti |
| Google Places API (New) Text Search | 🔌 | `GOOGLE_PLACES_API_KEY`, Places API (New) etkin, faturalama | `DISCOVERY_PROVIDER=google_places`, `cli wf1 --sector beauty --city İzmir --limit 5`; sonuçlar panelde. Politika: veriler 30 günden uzun önbelleklenmez (yeniden çekme gerekir), atıf kuralları. Yanıt eşlemesi `mapPlaces` birim testli. |
| Web sitesi gözlemi | ✅ | — | robots.txt kontrolü, UA `BaysSystemsBot/1.0`; fixture ile testli |
| CSV içe aktarım | ✅ | `name,website,phone,email,city,district,address,instagram` | `cli import-csv --file x.csv --sector beauty` veya panel API |
| Anthropic Messages API | 🔌 | `ANTHROPIC_API_KEY`, model `ANTHROPIC_MODEL` | `AI_PROVIDER=anthropic`; çıktı şema doğrulamalı, hatada şablona düşer; `AI_DAILY_CALL_LIMIT` |
| SMTP (nodemailer) | 🔌 | `SMTP_*`, `EMAIL_FROM_*`, `EMAIL_REPLY_DOMAIN` | `email:preflight` → `provider.verify`; EMAIL_DELIVERABILITY protokolü |
| Resend API + webhook | 🔌 | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend panelinde webhook → `https://acq.bayssystem.com/webhooks/email/resend`; svix imzası doğrulanır |
| IMAP (gelen yanıt) | 🔌 | n8n IMAP kimlik bilgisi (WF3) | Test e-postasına yanıt → panel Yanıtlar |
| n8n (3 workflow) | 🔌 | `BAYS_API_URL`, `BAYS_N8N_SHARED_SECRET` n8n ortamında | WF1 manuel çalıştır → Sistem → workflow_runs; `tools/validate-n8n.mjs` yapısal kontrol geçti; **n8n'e gerçek import bu ortamda yapılmadı** |
| WhatsApp Cloud API | 🔌 (yalnız alma) | `WHATSAPP_*`; onaylı şablon; opt-in | Webhook doğrulama (GET) ve imzalı olay (POST) testli; **gönderim adaptörü yok** (opt-in + şablon politikası sağlanmadan eklenmez) |
| Instagram DM | ⛔ otomatik soğuk DM | — | Politika `manual_task`; panelde manuel görev |
| LinkedIn mesaj | ⛔ otomatik soğuk mesaj | — | Politika `manual_task` |
| İYS / KVKK | 🔌 kapı | Hukuki doğrulama | `COMPLIANCE_IYS_VERIFIED`, `COMPLIANCE_KVKK_VERIFIED` → policy |
| Klinik tanıtım mevzuatı | 🔌 kapı | Hukuki doğrulama | `COMPLIANCE_CLINIC_ADVERTISING_VERIFIED`; referans kampanyası `compliance_status=pending` |
| Caddy / HTTPS | 🔌 | `deploy/Caddyfile.snippet` | `caddy validate`; `curl -I https://acq.bayssystem.com/api/health` |
| Docker Compose | 🔌 | Docker | `docker compose build` — **bu ortamda Docker daemon yoktu, derleme doğrulanmadı** |
| PWA (Android) | ✅ e2e | HTTPS | Manifest/SW/ikon e2e testli; gerçek cihazda "Ana ekrana ekle" doğrulanmalı |
| Video üretim motoru | ⛔ V1 dışı | — | Manuel video yükleme + kampanya takibi çalışıyor; otomatik üretim sonraki sürüm |
