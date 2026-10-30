#!/usr/bin/env bash
# Yedekten geri yükleme. DİKKAT: hedef veritabanındaki mevcut nesneleri değiştirir.
# Kullanım: deploy/scripts/restore.sh backups/bays_acq-YYYYmmdd-HHMMSS.dump [DATABASE_URL]
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
DUMP="${1:?yedek dosyası gerekli}"
TARGET="${2:-$DATABASE_URL}"
if [ -f "$DUMP.sha256" ]; then sha256sum -c "$DUMP.sha256"; fi
case "$TARGET" in *n8n*) echo "HATA: hedef n8n veritabanına benziyor, iptal."; exit 2;; esac
read -r -p "Hedef: $TARGET — mevcut veriler değiştirilecek. Devam? (yes/no) " ok
[ "$ok" = "yes" ] || exit 1
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$DUMP"
echo "Geri yükleme tamamlandı. API'yi yeniden başlatın ve panelden System Health'i kontrol edin."
