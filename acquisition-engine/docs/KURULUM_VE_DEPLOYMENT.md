# Kurulum ve deployment rehberi

Hedef: Hetzner VPS (Ubuntu 24.04), mevcut n8n + Caddy + (varsa) PostgreSQL'e **dokunmadan** `acq.bayssystem.com` altında izole kurulum. Üretim ortamına geçiş ayrı onaya bağlıdır; bu rehber kurulumu **test modunda** (DRY_RUN=true) bitirir.

## 0. Ön kontrol

```bash
git clone <repo> /opt/bays-acq && cd /opt/bays-acq/acquisition-engine
deploy/scripts/preflight.sh      # RAM/disk/port/Postgres/env kontrolü
```

Minimum öneri: 1 GB boş RAM, 2 GB boş disk, Node 22 (Docker kullanılmayacaksa).

## 1. Veritabanı (izole)

**Seçenek A — mevcut Postgres'te yeni DB (önerilen):**

```sql
CREATE ROLE bays_acq LOGIN PASSWORD '<güçlü parola>';
CREATE DATABASE bays_acq OWNER bays_acq;
```

n8n'in veritabanı, rolü ve tabloları değişmez. `DATABASE_URL=postgres://bays_acq:...@127.0.0.1:5432/bays_acq`.

**Seçenek B — ayrı Postgres konteyneri:** `docker compose --profile db up -d db` (port 127.0.0.1:5433). Daha fazla RAM kullanır.

## 2. Ortam dosyası

```bash
cp .env.example .env
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # N8N_SHARED_SECRET
```

Zorunlu: `DATABASE_URL`, `SESSION_SECRET`, `N8N_SHARED_SECRET`, `PUBLIC_BASE_URL=https://acq.bayssystem.com`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12 karakter). İlk aşamada **değiştirmeyin**: `DRY_RUN=true`, `LIVE_OUTREACH_ENABLED=false`, `EMAIL_PROVIDER=mock`.

`.env` dosyası `chmod 600` olmalı; depoya asla eklenmez.

## 3. Kurulum — Docker Compose (önerilen)

```bash
docker compose build
docker compose up -d api panel          # (Seçenek B ise: --profile db)
docker compose exec api node dist/cli.js seed   # migration + sektör + katalog + yönetici
docker compose logs -f api | head
curl -s http://127.0.0.1:4100/api/health
```

`AUTO_MIGRATE=true` ile API her açılışta eksik migration'ları uygular.

## 3'. Kurulum — Docker'sız (systemd)

```bash
npm --prefix apps/api ci && npm --prefix apps/api run build
npm --prefix apps/panel ci && npm --prefix apps/panel run build
npm --prefix apps/api run seed
sudo useradd -r -s /usr/sbin/nologin bays && sudo chown -R bays /opt/bays-acq
sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now bays-acq-api bays-acq-panel
```

Not: panel `standalone` çıktısı için `cp -r apps/panel/public apps/panel/.next/standalone/ && cp -r apps/panel/.next/static apps/panel/.next/standalone/.next/` gerekir (Next.js standalone gereksinimi).

## 4. Caddy

`deploy/Caddyfile.snippet` içeriğini mevcut Caddyfile'ın **sonuna** ekleyin (mevcut bloklara dokunmayın), `acq.bayssystem.com` DNS A kaydının sunucuyu gösterdiğini doğrulayın, sonra:

```bash
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

HTTPS sertifikası otomatik alınır. `/api/*`, `/webhooks/*`, `/internal/*` → 4100; geri kalan → 4200.

## 5. n8n workflow'larını içe aktarma

1. n8n'de ortam değişkenlerini tanımlayın (docker ise n8n servisinin `environment:` bölümüne; mevcut değişkenlere **ekleme** yapın):
   - `BAYS_API_URL=https://acq.bayssystem.com` (ya da n8n aynı makinedeyse `http://127.0.0.1:4100`; Docker içinden `http://host.docker.internal:4100` veya `http://172.17.0.1:4100`)
   - `BAYS_N8N_SHARED_SECRET=<.env'deki N8N_SHARED_SECRET>`
   - opsiyonel `BAYS_PILOT_CITIES=İstanbul,Ankara,İzmir`, `BAYS_TARGET_PER_SECTOR=30`, `BAYS_WF2_PREPARE_LIMIT=20`, `BAYS_WF2_SEND_LIMIT=10`
   - `$env` ifadelerinin çalışması için `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (varsayılan) olmalı.
2. n8n → Workflows → Import from file → `n8n/WF1_*.json`, `WF2_*.json`, `WF3_*.json`.
3. WF3'teki **IMAP** düğümüne bir IMAP kimlik bilgisi bağlayın (yanıtların geldiği posta kutusu; `reply+*@EMAIL_REPLY_DOMAIN` adreslerinin bu kutuya düşmesi için catch-all/alias gerekir).
4. Önce WF1'i **Manuel tetikle** ile çalıştırın; panel → Sistem → Workflow durumu'nda `wf1_discovery` görünmeli.
5. Sorunsuzsa workflow'ları aktifleştirin. Zamanlamalar: WF1 iş günleri 08:00; WF2 iş günleri 09–18 her 2 saat; WF3 IMAP sürekli, metrik 23:50 günlük / Pazartesi 07:30 haftalık (Europe/Istanbul).

Mevcut workflow'larınız değiştirilmez; bu üçü `bays-acq` etiketiyle ayrı durur. Yeniden üretmek için: `node tools/build-n8n.mjs && node tools/validate-n8n.mjs`.

## 6. Panelin telefona eklenmesi (Android)

Chrome → `https://acq.bayssystem.com` → giriş → menü → **Ana ekrana ekle** (veya otomatik "Yükle" çubuğu). Uygulama tam ekran açılır; alt gezinme çubuğu 6 bölümü taşır.

## 7. Mock'tan gerçeğe geçiş sırası (her adım ayrı onay)

1. `DISCOVERY_PROVIDER=google_places` + `GOOGLE_PLACES_API_KEY` → WF1'i tek şehir/sektörle çalıştırın, `GOOGLE_PLACES_DAILY_LIMIT` ile maliyeti sınırlayın.
2. `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` → Onaylar sayfasında AI taslaklarını okuyun; doğrulama uyarılarını izleyin.
3. E-posta: [EMAIL_DELIVERABILITY.md](EMAIL_DELIVERABILITY.md) kapılarını geçin; `EMAIL_PROVIDER=smtp|resend`, `DRY_RUN=false`, `LIVE_OUTREACH_ENABLED=true` ama `TEST_RECIPIENTS` ile yalnız test alıcıları (politika gereği gerçek alıcılar manuel göreve düşer — çünkü `COMPLIANCE_*` hâlâ false).
4. Hukuki doğrulama sonrası `COMPLIANCE_IYS_VERIFIED=true`, `COMPLIANCE_KVKK_VERIFIED=true` (klinik için ayrıca `COMPLIANCE_CLINIC_ADVERTISING_VERIFIED=true`). Bu andan itibaren onaylı e-postalar gerçek alıcılara gider.

## 8. Güncelleme

```bash
git pull
docker compose build && docker compose up -d api panel     # migration'lar AUTO_MIGRATE ile uygulanır
# veya systemd: npm ci/build → systemctl restart bays-acq-api bays-acq-panel
```

Güncelleme öncesi her zaman `deploy/scripts/backup.sh`.
