# BaysSystems — Customer Acquisition Engine V1

Üç pilot sektörde (eğitim, güzellik, klinik) potansiyel müşterileri bulan, puanlayan, uygun BaysSystems hizmetini öneren, **insan onayından sonra** uygun kanallarda iletişim kuran ve satış sürecini takip eden; telefondan yönetilebilen (PWA) AI destekli müşteri kazanım sistemi.

> Durum: geliştirme teslimi. Mock sağlayıcılarla tüm akışlar otomatik testlerle doğrulandı; gerçek Google Places, Anthropic, SMTP/Resend, IMAP ve n8n bağlantıları **bu ortamda doğrulanmadı**. Ayrıntı: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Bileşenler

| Bileşen | Yol | Açıklama |
| --- | --- | --- |
| API servisi | `apps/api` | Node 22 + Fastify + PostgreSQL. Keşif, puanlama, taslak, politika, onay, gönderim, yanıt işleme, satış, metrik, sağlık. n8n'in çağırdığı HMAC imzalı iç uçlar. |
| Panel (PWA) | `apps/panel` | Next.js 15, mobil öncelikli, Türkçe, Android ana ekrana eklenebilir. 6 bölüm: Özet, Leadler, Onaylar, Satış (Conversations & Deals), Gelir, Sistem. |
| Veritabanı | `db/migrations` | PostgreSQL şeması (idempotency, unique kısıtlar, indeksler). Ayrı `bays_acq` veritabanı. |
| n8n workflow'ları | `n8n/*.json` | WF1 Lead Discovery & Qualification, WF2 Outreach Preparation & Approval, WF3 Reply & Sales Management. |
| Yapılandırma | `config/sectors/*.json`, `config/services.json` | Sektör sinyalleri/eşikleri, hizmet kataloğu. Fiyatlar veritabanında (`price_plans`). |
| Dağıtım | `docker-compose.yml`, `deploy/` | Docker Compose, Caddy bloğu, systemd birimleri, yedekleme/geri yükleme. |
| Dokümanlar | `docs/` | Mimari, kurulum, e-posta teslim edilebilirliği, entegrasyon listesi, uyumluluk, hata giderme, test raporu. |

## Hızlı başlangıç (geliştirme)

```bash
cd acquisition-engine
cp .env.example .env            # SESSION_SECRET, N8N_SHARED_SECRET, DATABASE_URL, ADMIN_* doldurun
npm run install:all
npm run seed                    # migrate + sektörler + katalog + yönetici kullanıcı
npm run dev:api                 # http://127.0.0.1:4100
npm run dev:panel               # http://localhost:4200 (/api → API'ye yönlendirilir)
```

Mock verilerle akışı denemek için:

```bash
npm --prefix apps/api run cli -- wf1 --sector beauty --city İstanbul
npm --prefix apps/api run cli -- wf2-prepare
# panel → Onaylar → Onayla ; sonra:
npm --prefix apps/api run cli -- wf2-send      # DRY_RUN=true: sağlayıcıya gitmez, dry_run olayı yazılır
npm --prefix apps/api run cli -- wf3-metrics
```

## Testler

```bash
npm run test:api     # 62 test (PostgreSQL gerektirir: DATABASE_URL_TEST)
npm run test:panel   # panel birim testleri
npm run test:e2e     # Playwright: mobil (Pixel 7) + masaüstü; API+panel otomatik başlatılır
npm run n8n:validate # workflow JSON yapısal kontrol
```

## Güvenli varsayılanlar

`DRY_RUN=true`, `LIVE_OUTREACH_ENABLED=false`, `EMAIL_PROVIDER=mock`, `AI_PROVIDER=mock`, `DISCOVERY_PROVIDER=mock`, tüm `COMPLIANCE_*_VERIFIED=false`. Bu bayraklar değişmeden hiçbir gerçek alıcıya e-posta gidemez; Instagram/LinkedIn'de otomatik soğuk mesaj hiçbir modda yapılmaz; WhatsApp yalnız opt-in + onaylı şablon ile.

Belgeler: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/KURULUM_VE_DEPLOYMENT.md](docs/KURULUM_VE_DEPLOYMENT.md) · [docs/EMAIL_DELIVERABILITY.md](docs/EMAIL_DELIVERABILITY.md) · [docs/INTEGRATION_CHECKLIST.md](docs/INTEGRATION_CHECKLIST.md) · [docs/COMPLIANCE.md](docs/COMPLIANCE.md) · [docs/TROUBLESHOOTING_ROLLBACK.md](docs/TROUBLESHOOTING_ROLLBACK.md) · [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
