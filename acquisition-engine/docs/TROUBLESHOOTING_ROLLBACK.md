# Hata giderme ve rollback

## Hızlı tanı

| Belirti | Kontrol | Çözüm |
| --- | --- | --- |
| Panel açılmıyor / 502 | `curl -I http://127.0.0.1:4200/login`, `docker compose ps` / `systemctl status bays-acq-panel` | Paneli yeniden başlatın; Caddy upstream portunu doğrulayın. |
| Giriş yapılamıyor | `curl -s http://127.0.0.1:4100/api/health`; API logları | `SESSION_SECRET` 32+ karakter mi; `PUBLIC_BASE_URL` https ise çerez `Secure` — http ile test ediyorsanız `PUBLIC_BASE_URL=http://...` kullanın. |
| "Yapılandırma hatası" ile API açılmıyor | Log satırı eksik değişkeni söyler | `.env` düzeltin. |
| n8n 401 "Geçersiz n8n imzası" | n8n `BAYS_N8N_SHARED_SECRET` = API `N8N_SHARED_SECRET`?; sunucu saatleri (5 dk pencere) | Sırrı eşitleyin, `timedatectl` ile NTP. |
| n8n HTTP düğümü bağlanamıyor | n8n Docker'daysa `127.0.0.1` n8n konteynerini işaret eder | `BAYS_API_URL=http://host.docker.internal:4100` veya `http://172.17.0.1:4100`; Caddy üzerinden `https://acq.bayssystem.com` da olur. |
| Sistem → Gönderim: DURDU | `outreach_paused.reason` | Nedeni giderin (bounce, kota, hata), panelden **Gönderimi sürdür**. |
| E-posta `error` olayları | Sistem → Son e-posta hataları; `email:preflight` | SMTP kimlik/port/TLS; sağlayıcı kotası; DNS. |
| Yanıtlar eşleşmiyor (`match_method=none`) | `reply+token@` adresi IMAP kutusuna düşüyor mu; `In-Reply-To` korunuyor mu | Catch-all/plus-addressing; Yanıtlar sekmesinde manuel eşleme. |
| Google Places "limit aşıldı" | `email_quota_usage` tablosu `provider='google_places'` | `GOOGLE_PLACES_DAILY_LIMIT` artırın veya ertesi gün. |
| Mükerrer işletme | `businesses.dedup_key`, `normalized_name` | Panelde engelle/birleştirme yok; SQL ile `UPDATE ... SET dedup_key` ve kanıt taşıma (nadir). |

Loglar: Docker `docker compose logs -f api panel`; systemd `journalctl -u bays-acq-api -f`. API JSON log satırlarında sırlar maskelenir.

## Acil durdurma (kill-switch)

1. Panel → Sistem → **Gönderimi durdur** (owner rolü). Kuyruktaki işler `blocked` olur, yeni iş alınmaz.
2. Alternatif: `.env` içinde `DRY_RUN=true` yapıp API'yi yeniden başlatın — hiçbir sağlayıcı çağrısı yapılmaz.
3. n8n'de WF2'yi pasifleştirin.

## Rollback

### Uygulama sürümü

```bash
cd /opt/bays-acq && git log --oneline | head   # önceki commit
git checkout <önceki-commit> -- acquisition-engine
docker compose build && docker compose up -d api panel   # veya systemd restart
```

Migration'lar ileri yönlüdür; şemayı geri almak için **yedekten geri yükleme** kullanılır.

### Veritabanı

```bash
deploy/scripts/backup.sh                 # her değişiklik öncesi
deploy/scripts/restore.sh backups/bays_acq-<tarih>.dump
```

Geri yükleme yalnız `bays_acq` veritabanını etkiler; betik hedef adı `n8n` içeriyorsa durur.

### Tam kaldırma (mevcut sistemler etkilenmez)

```bash
docker compose down            # konteynerler; `-v` ile ayrı PG verisi de silinir
# Caddyfile'dan acq.bayssystem.com bloğunu kaldırıp reload
# n8n'de 3 workflow'u silin (etiket: bays-acq)
# psql: DROP DATABASE bays_acq; DROP ROLE bays_acq;
```

## Bakım

- Günlük yedek: `0 3 * * * /opt/bays-acq/acquisition-engine/deploy/scripts/backup.sh /var/backups/bays-acq` (cron). Yedekleri sunucu dışına kopyalayın.
- `audit_log` ve `send_events` 6 ayda bir arşivlenebilir (`DELETE ... WHERE created_at < now() - interval '6 months'` yedek sonrası).
- `sessions` süresi dolanlar API tarafından saatlik temizlenir.
