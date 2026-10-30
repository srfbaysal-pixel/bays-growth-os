# Kurulum ve deployment rehberi

Hedef: Hetzner VPS (Ubuntu 24.04), mevcut n8n + Caddy + (varsa) PostgreSQL'e ve **eski `acq.bayssystem.com/review` sistemine dokunmadan** izole kurulum. Yeni sürümün tüm örnek adları `bays-acq-v1`'dir: Compose projesi `bays-acq-v1`, dizin `/opt/bays-acq-v1`, imajlar `bays-acq-v1-api` / `bays-acq-v1-panel`, systemd `bays-acq-v1-*.service`, yedek dizini `/var/backups/bays-acq-v1`, alan adı **kullanıcı tarafından belirlenecek** `BAYS_ACQ_V1_DOMAIN` (örnek: `acq-v1.bayssystem.com`; tahsis edilmiş sayılmaz).

Üretim ortamına geçiş ayrı onaya bağlıdır; bu rehber kurulumu **test modunda** (DRY_RUN=true) bitirir. Sunucu envanteri (mevcut Caddyfile içeriği, n8n'in Docker ağı, PostgreSQL erişimi) henüz doğrulanmadı; her adımdaki önkoşullar sunucuda kontrol edilmelidir.

## 0. Ön kontrol

```bash
git clone <repo> /opt/bays-acq-v1 && cd /opt/bays-acq-v1/acquisition-engine
deploy/scripts/preflight.sh      # RAM/disk/port/Postgres/env kontrolü
```

Minimum öneri: 1 GB boş RAM, 2 GB boş disk, Node 22 (Docker kullanılmayacaksa).

## 1. Veritabanı (izole)

Her seçenekte `EXPECTED_DB_NAME=bays_acq` koruması geçerlidir: migration/seed/API, gerçek `current_database()` bu ad değilse veya `n8n` içeriyorsa durur.

**Seçenek A — sunucudaki (haricî) PostgreSQL'de yeni DB.** En az kaynak kullanır.

```sql
CREATE ROLE bays_acq LOGIN PASSWORD '<güçlü parola>';
CREATE DATABASE bays_acq OWNER bays_acq;
```

API Docker'da çalışıyorsa `127.0.0.1` konteynerin kendisidir; `DATABASE_URL` **`host.docker.internal:5432`** kullanır (Compose `extra_hosts: host-gateway` ile tanımlıdır). ÖNKOŞUL (sunucuda doğrulanmadı, mevcut n8n erişimi bozulmadan eklenmeli): PostgreSQL `listen_addresses` Docker köprü adresini (`172.17.0.1`) kapsamalı ve `pg_hba.conf` içinde `host bays_acq bays_acq 172.16.0.0/12 scram-sha-256` benzeri bir satır olmalı; değişiklik PostgreSQL reload gerektirir ve ayrıca onaya tabidir. Docker'sız (systemd) kurulumda `127.0.0.1:5432` yeterlidir.

**Seçenek B — aynı Compose projesinde ayrı PostgreSQL** (`deploy/compose.db.yml`). `DATABASE_URL` otomatik olarak `db:5432` olur; `.env` içinde **`BAYS_ACQ_DB_PASSWORD`** zorunludur (güvensiz varsayılan yoktur, eksikse `docker compose config` durur). PostgreSQL portu host'a yayımlanmaz. Daha fazla RAM kullanır (~100–150 MB).

## 2. Ortam dosyası

```bash
cp .env.example .env
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # N8N_SHARED_SECRET
```

Zorunlu: `DATABASE_URL`, `EXPECTED_DB_NAME` (varsayılan `bays_acq`; migration/seed/API yalnız bu adda çalışır, `n8n` içeren adda asla), `SESSION_SECRET`, `N8N_SHARED_SECRET`, `BAYS_ACQ_V1_DOMAIN` ve tutarlı `PUBLIC_BASE_URL=https://<BAYS_ACQ_V1_DOMAIN>`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12 karakter). Opsiyonel: `INTERNAL_ALLOWED_IPS` (iç uçlara izinli ağlar), `ALERT_WEBHOOK_URL` (kill-switch bildirimi). İlk aşamada **değiştirmeyin**: `DRY_RUN=true`, `LIVE_OUTREACH_ENABLED=false`, `EMAIL_PROVIDER=mock`.

`.env` dosyası `chmod 600` olmalı; depoya asla eklenmez.

## 3. Kurulum — Docker Compose (önerilen)

```bash
deploy/scripts/build-images.sh                 # bellek/swap kontrollü sıralı derleme; RAM yetersizse durur
# RAM dar ise başka makinede: deploy/scripts/build-images.sh --export bays-acq-v1-images.tar → sunucuda docker load -i ...
docker compose config -q                       # A: yapılandırma geçerli mi (parola/ağ istemez)
docker compose up -d api panel                 # A (haricî PostgreSQL)
# B: docker compose -f docker-compose.yml -f deploy/compose.db.yml up -d
```

Migration ilk kurulumda **otomatik değildir** (`AUTO_MIGRATE=false`). Önce kimliği doğrulayıp açık adım olarak çalıştırın:

```bash
docker compose run --rm api node dist/cli.js migrate    # hedef DB adını doğrular, şemayı kurar
docker compose run --rm api node dist/cli.js seed       # sektörler + katalog + yönetici
curl -s http://127.0.0.1:4100/api/health
```

Sonraki güncellemelerde `AUTO_MIGRATE=true` ile açılışta uygulanabilir; kimlik koruması yine çalışır.

### 3a. Mevcut Docker n8n ile özel ağ bağlantısı

n8n Docker'daysa host loopback'ine yayımlanan `127.0.0.1:4100` n8n konteynerinden erişilemez. İki yol:

- **Önerilen:** `deploy/compose.n8n-network.yml` ile API, n8n'in mevcut Docker ağına da katılır ve `bays-acq-v1-api` adıyla erişilebilir olur. Önkoşul: ağ adı (`docker network ls`, `docker inspect <n8n-konteyner>`), `.env` → `N8N_DOCKER_NETWORK=<ad>`. n8n tarafında `BAYS_API_URL=http://bays-acq-v1-api:4100`. Host'ta ek port açılmaz, n8n ayarları değişmez; kaynak IP özel aralıkta kaldığı için `INTERNAL_ALLOWED_IPS` geçer, HMAC yine zorunludur.
  ```bash
  docker compose -f docker-compose.yml -f deploy/compose.n8n-network.yml up -d api panel
  ```
- n8n host'ta çalışıyorsa `BAYS_API_URL=http://127.0.0.1:4100` yeterlidir.

Alan adı üzerinden (`https://<BAYS_ACQ_V1_DOMAIN>/internal/...`) çağrı **kapalıdır** (Caddy 403); sırlar URL'ye veya workflow JSON'una yazılmaz.

## 3'. Kurulum — Docker'sız (systemd)

```bash
npm --prefix apps/api ci && npm --prefix apps/api run build
npm --prefix apps/panel ci && npm --prefix apps/panel run build
npm --prefix apps/api run seed
sudo useradd -r -s /usr/sbin/nologin bays && sudo chown -R bays /opt/bays-acq-v1
sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now bays-acq-v1-api bays-acq-v1-panel
```

Not: panel `standalone` çıktısı için `cp -r apps/panel/public apps/panel/.next/standalone/ && cp -r apps/panel/.next/static apps/panel/.next/standalone/.next/` gerekir (Next.js standalone gereksinimi).

## 4. Caddy — eski `/review` sistemini koruyarak

Mevcut Caddyfile'da `acq.bayssystem.com` bloğu eski sistemi (`/review`) sunuyor olabilir; **o bloğa dokunulmaz ve aynı alan adı için ikinci blok eklenmez.** Kontrollü entegrasyon planı (her adım kullanıcı onayıyla, sunucuda):

1. Envanter: `caddy adapt --config /etc/caddy/Caddyfile` ile mevcut site blokları ve upstream portları listelenir; 4100/4200 portlarının boş olduğu doğrulanır.
2. Alan adı seçimi: yeni panel için ayrı bir alt alan adı (`BAYS_ACQ_V1_DOMAIN`, örn. `acq-v1.bayssystem.com`) belirlenir, DNS A kaydı eklenir. Eski alan adı değişmez.
3. `deploy/Caddyfile.snippet` içeriği **ayrı dosya** olarak eklenir (örn. `/etc/caddy/sites/bays-acq-v1.caddy` + ana dosyada `import sites/*.caddy`) ve Caddy ortamında `BAYS_ACQ_V1_DOMAIN` tanımlanır (systemd `Environment=` veya `/etc/caddy/env`).
4. `caddy validate --config /etc/caddy/Caddyfile` → başarılıysa `systemctl reload caddy` (yalnız reload; restart değil).
5. Doğrulama: `curl -I https://<yeni-alan-adı>/api/health` 200; `https://<yeni-alan-adı>/internal/heartbeat` 403; eski `https://acq.bayssystem.com/review` değişmeden açılıyor.
6. Geri alma: eklenen dosyayı kaldırıp `caddy validate` + `reload`. Eski sistem bu süreçte hiç değişmediği için geri alma yalnız yeni bloğun kaldırılmasıdır.

n8n'in yeniden başlatılması yalnız ortam değişkeni eklenmesi için gerekir (§5) ve mevcut otomasyonları kısa süre keser; bu da ayrıca onaya bağlıdır.

## 5. n8n workflow'larını içe aktarma

1. n8n'de ortam değişkenlerini tanımlayın (docker ise n8n servisinin `environment:` bölümüne; mevcut değişkenlere **ekleme** yapın):
   - `BAYS_API_URL`: n8n host'ta ise **`http://127.0.0.1:4100`**; n8n Docker'da ise **`http://bays-acq-v1-api:4100`** (§3a özel ağ). `host.docker.internal`/`172.17.0.1` host loopback yayınına tek başına ulaşamaz; alan adı üzerinden `/internal/*` kapalıdır.
   - `BAYS_N8N_SHARED_SECRET=<.env'deki N8N_SHARED_SECRET>`
   - opsiyonel `BAYS_PILOT_CITIES=İstanbul,Ankara,İzmir`, `BAYS_TARGET_PER_SECTOR=30`, `BAYS_WF2_PREPARE_LIMIT=20`, `BAYS_WF2_SEND_LIMIT=10`
   - `$env` ifadelerinin çalışması için `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (varsayılan) olmalı.
2. n8n → Workflows → Import from file → `n8n/WF1_*.json`, `WF2_*.json`, `WF3_*.json`.
3. WF3'teki **IMAP** düğümüne bir IMAP kimlik bilgisi bağlayın (yanıtların geldiği posta kutusu; `reply+*@EMAIL_REPLY_DOMAIN` adreslerinin bu kutuya düşmesi için catch-all/alias gerekir).
4. Önce WF1'i **Manuel tetikle** ile çalıştırın; panel → Sistem → Workflow durumu'nda `wf1_discovery` görünmeli.
5. Sorunsuzsa workflow'ları aktifleştirin (dosyalar `active=false` olarak teslim edilir; aktivasyon kullanıcı kararıdır). Zamanlamalar: WF1 iş günleri 08:00; WF2 iş günleri 09–18 her 2 saat; WF3 IMAP sürekli, metrik 23:50 günlük / Pazartesi 07:30 haftalık (Europe/Istanbul).

Mevcut workflow'larınız değiştirilmez; bu üçü `bays-acq` etiketiyle ayrı durur. Yeniden üretmek için: `node tools/build-n8n.mjs && node tools/validate-n8n.mjs`.

## 6. Panelin telefona eklenmesi (Android)

Chrome → `https://<BAYS_ACQ_V1_DOMAIN>` → giriş → menü → **Ana ekrana ekle** (veya otomatik "Yükle" çubuğu). Uygulama tam ekran açılır; alt gezinme çubuğu 6 bölümü taşır.

## 7. Mock'tan gerçeğe geçiş sırası (her adım ayrı onay)

1. `DISCOVERY_PROVIDER=google_places` + `GOOGLE_PLACES_API_KEY` → WF1'i tek şehir/sektörle çalıştırın, `GOOGLE_PLACES_DAILY_LIMIT` ile maliyeti sınırlayın.
2. `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` → Onaylar sayfasında AI taslaklarını okuyun; doğrulama uyarılarını izleyin.
3. E-posta: [EMAIL_DELIVERABILITY.md](EMAIL_DELIVERABILITY.md) kapılarını geçin; `EMAIL_PROVIDER=smtp|resend`, `DRY_RUN=false`, `LIVE_OUTREACH_ENABLED=true` ama `TEST_RECIPIENTS` ile yalnız test alıcıları (politika gereği gerçek alıcılar manuel göreve düşer — çünkü `COMPLIANCE_*` hâlâ false).
4. Hukuki doğrulama sonrası `COMPLIANCE_IYS_VERIFIED=true`, `COMPLIANCE_KVKK_VERIFIED=true` (klinik için ayrıca `COMPLIANCE_CLINIC_ADVERTISING_VERIFIED=true`). Bu andan itibaren onaylı e-postalar gerçek alıcılara gider.

## 7'. DRY_RUN provası sonrası temizlik

Kuru çalışma kayıtları (`dry_run` taslak ve işler) gerçek lead'lerin yeniden işlenmesini engellemez; yine de üretim veritabanını temiz başlatmak için:

```bash
npm --prefix apps/api run cli -- purge-dry-run      # yalnız dry_run kayıtları ve CLI/e2e workflow kayıtlarını siler
```

Dry-run gönderimler sağlayıcı kotasını (`email_quota_usage`) tüketmez ve kota kaynaklı kill-switch üretmez (D6).

## 8. Güncelleme

```bash
git pull
docker compose build && docker compose up -d api panel     # migration'lar AUTO_MIGRATE ile uygulanır
# veya systemd: npm ci/build → systemctl restart bays-acq-api bays-acq-panel
```

Güncelleme öncesi her zaman `deploy/scripts/backup.sh /var/backups/bays-acq-v1` (hedef DB kimliği doğrulanır, çıktıda parola görünmez).
