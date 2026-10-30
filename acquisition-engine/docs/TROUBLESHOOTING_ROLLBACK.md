# Hata giderme ve rollback

## Hızlı tanı

| Belirti | Kontrol | Çözüm |
| --- | --- | --- |
| Panel açılmıyor / 502 | `curl -I http://127.0.0.1:4200/login`, `docker compose ps` / `systemctl status bays-acq-panel` | Paneli yeniden başlatın; Caddy upstream portunu doğrulayın. |
| Giriş yapılamıyor | `curl -s http://127.0.0.1:4100/api/health`; API logları | `SESSION_SECRET` 32+ karakter mi; `PUBLIC_BASE_URL` https ise çerez `Secure` — http ile test ediyorsanız `PUBLIC_BASE_URL=http://...` kullanın. |
| API açılışta "Yapılandırma hatası: ALERT_WEBHOOK_URL" | Değer dolu ama geçerli URL değil | Boş bırakın (bildirim kapalı) veya tam URL girin; hata metni değeri içermez. |
| Docker API DB'ye bağlanamıyor (ECONNREFUSED 127.0.0.1) | Konteyner içinde 127.0.0.1 konteynerin kendisi | Seçenek A: `host.docker.internal` + PostgreSQL köprü arayüzü/pg_hba önkoşulu; Seçenek B: `deploy/compose.db.yml`. |
| "Yapılandırma hatası" ile API açılmıyor | Log satırı eksik değişkeni söyler | `.env` düzeltin. |
| n8n 403 "yalnız izinli ağlardan" | Kaynak IP `INTERNAL_ALLOWED_IPS` / Caddy `remote_ip` dışında | n8n'i `http://127.0.0.1:4100` ile çağırın ya da sunucu genel IP'sini iki listeye ekleyin. |
| API açılmıyor: "Durduruldu: hedef veritabanı ..." | `DATABASE_URL` beklenen DB'yi göstermiyor | `EXPECTED_DB_NAME` ile DB adı eşleşmeli; n8n DB'si asla kullanılamaz. |
| n8n 401 "Geçersiz n8n imzası" | n8n `BAYS_N8N_SHARED_SECRET` = API `N8N_SHARED_SECRET`?; sunucu saatleri (5 dk pencere) | Sırrı eşitleyin, `timedatectl` ile NTP. |
| n8n HTTP düğümü bağlanamıyor | n8n Docker'daysa `127.0.0.1` n8n konteynerini işaret eder; host loopback yayını konteynerden görünmez | `deploy/compose.n8n-network.yml` ile API'yi n8n ağına katın ve `BAYS_API_URL=http://bays-acq-v1-api:4100` kullanın. Alan adı üzerinden `/internal/*` kapalıdır (403). |
| Sistem → Gönderim: DURDU | `outreach_paused.reason` | Nedeni giderin (bounce, kota, hata), panelden **Gönderimi sürdür**. |
| E-posta `error` olayları | Sistem → Son e-posta hataları; `email:preflight` | SMTP kimlik/port/TLS; sağlayıcı kotası; DNS. |
| Yanıtlar eşleşmiyor (`match_method=none`) | `reply+token@` adresi IMAP kutusuna düşüyor mu; `In-Reply-To` korunuyor mu | Catch-all/plus-addressing; Yanıtlar sekmesinde manuel eşleme. |
| Google Places "limit aşıldı" | `email_quota_usage` tablosu `provider='google_places'` | `GOOGLE_PLACES_DAILY_LIMIT` artırın veya ertesi gün. |
| Prova sonrası `dry_run` kayıtları | Onaylar → Kuyrukta/Gönderilen filtreleri | `npm --prefix apps/api run cli -- purge-dry-run` |
| Mükerrer işletme | `businesses.dedup_key`, `normalized_name` | Panelde engelle/birleştirme yok; SQL ile `UPDATE ... SET dedup_key` ve kanıt taşıma (nadir). |

Loglar: Docker `docker compose logs -f api panel`; systemd `journalctl -u bays-acq-api -f`. API JSON log satırlarında sırlar maskelenir.

## Acil durdurma (kill-switch)

1. Panel → Sistem → **Gönderimi durdur** (owner rolü). Kuyruktaki işler `blocked` olur, yeni iş alınmaz.
2. Alternatif: `.env` içinde `DRY_RUN=true` yapıp API'yi yeniden başlatın — hiçbir sağlayıcı çağrısı yapılmaz.
3. n8n'de WF2'yi pasifleştirin.

## Rollback

### Uygulama sürümü

```bash
cd /opt/bays-acq-v1 && git log --oneline | head   # önceki commit
git checkout <önceki-commit> -- acquisition-engine
docker compose build && docker compose up -d api panel   # veya systemd restart
```

Migration'lar ileri yönlüdür; şemayı geri almak için **yedekten geri yükleme** kullanılır.

### Veritabanı

```bash
deploy/scripts/backup.sh /var/backups/bays-acq-v1          # her değişiklik öncesi
deploy/scripts/restore.sh /var/backups/bays-acq-v1/bays_acq-<tarih>.dump   # onay ister; --yes yalnız otomasyon için
```

Her iki betik gerçek `current_database()` değerini `EXPECTED_DB_NAME` ile karşılaştırır; ad `n8n` içeriyorsa (büyük/küçük harf fark etmeksizin) veya beklenen addan farklıysa `pg_dump`/`pg_restore` hiç başlamaz. Sağlama dosyası (`.sha256`) zorunludur; eksik/uyumsuz sağlama veya okunamayan yedek geri yüklemeyi durdurur. Çıktılarda bağlantı parolası maskelenir.

### Yeni sürümü kaldırma (eski sistemler ve mevcut servisler etkilenmez)

Genel `docker compose down -v` veya volume silme komutu **kullanılmaz**; yalnız bu projeye ait kaynaklar, adıyla:

```bash
cd /opt/bays-acq-v1/acquisition-engine
docker compose -p bays-acq-v1 stop api panel && docker compose -p bays-acq-v1 rm api panel
# Seçenek B kullanıldıysa ve VERİ bilinçli olarak silinecekse (önce backup.sh):
#   docker compose -p bays-acq-v1 -f docker-compose.yml -f deploy/compose.db.yml down && docker volume rm bays-acq-v1_bays_acq_v1_pgdata
# Caddy: yalnız eklenen bays-acq-v1 site dosyasını kaldırıp validate + reload; eski acq.bayssystem.com bloğuna dokunulmaz
# n8n: yalnız 'bays-acq' etiketli 3 workflow silinir; diğer workflow'lar ve ayarlar değişmez
# PostgreSQL (Seçenek A, veri bilinçli silinecekse, önce backup.sh): DROP DATABASE bays_acq; DROP ROLE bays_acq;
```

## Bakım

- Günlük yedek: `0 3 * * * /opt/bays-acq-v1/acquisition-engine/deploy/scripts/backup.sh /var/backups/bays-acq-v1` (cron). Yedekleri sunucu dışına kopyalayın.
- `audit_log` ve `send_events` 6 ayda bir arşivlenebilir (`DELETE ... WHERE created_at < now() - interval '6 months'` yedek sonrası).
- `sessions` süresi dolanlar API tarafından saatlik temizlenir.
