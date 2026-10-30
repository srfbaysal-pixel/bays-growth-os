#!/usr/bin/env bash
# Yalnız beklenen (EXPECTED_DB_NAME) veritabanını yedekler; n8n DB'sine ASLA dokunmaz (D5).
# Kullanım: deploy/scripts/backup.sh [hedef_dizin]   — DATABASE_URL ve EXPECTED_DB_NAME .env'den veya ortamdan
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
. deploy/scripts/db-common.sh
: "${DATABASE_URL:?DATABASE_URL gerekli}"
EXPECTED_DB_NAME="${EXPECTED_DB_NAME:-bays_acq}"
assert_db_identity "$DATABASE_URL" "$EXPECTED_DB_NAME"
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/${EXPECTED_DB_NAME}-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL" 2> >(redact "$DATABASE_URL" >&2)
sha256sum "$OUT" > "$OUT.sha256"
# Okunabilirlik: dump içeriği listelenebiliyor mu?
pg_restore --list "$OUT" > /dev/null
find "$DEST" -name "${EXPECTED_DB_NAME}-*.dump*" -mtime +14 -delete
echo "Yedek: $OUT ($(du -h "$OUT" | cut -f1)), sağlama: $OUT.sha256"
