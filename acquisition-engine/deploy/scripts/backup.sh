#!/usr/bin/env bash
# Yalnız bays_acq veritabanını yedekler (mevcut n8n DB'sine dokunmaz).
# Kullanım: deploy/scripts/backup.sh [hedef_dizin]   (DATABASE_URL .env'den okunur)
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/bays_acq-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL"
sha256sum "$OUT" > "$OUT.sha256"
# 14 günden eski yedekleri sil
find "$DEST" -name 'bays_acq-*.dump*' -mtime +14 -delete
echo "Yedek: $OUT ($(du -h "$OUT" | cut -f1))"
