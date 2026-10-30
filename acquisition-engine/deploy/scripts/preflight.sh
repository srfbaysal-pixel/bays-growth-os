#!/usr/bin/env bash
# Kurulum öncesi kontrol: kaynak, port, Postgres erişimi, env dosyası.
set -uo pipefail
cd "$(dirname "$0")/../.."
echo "== Bellek =="; free -m | head -3
AVAIL=$(free -m | awk '/^Mem:/{print $7}'); SWAP=$(free -m | awk '/^Swap:/{print $2}')
[ "${AVAIL:-0}" -lt 900 ] && echo "UYARI: kullanılabilir RAM ${AVAIL} MB < 900 MB — çalışma zamanı için sınırda, derlemeyi sunucuda yapmayın"
[ "${SWAP:-0}" -lt 1024 ] && echo "UYARI: swap ${SWAP} MB < 1 GB — docker build / next build için en az 2 GB swap veya sunucu dışı derleme önerilir (deploy/scripts/build-images.sh)"
echo "== Disk =="; df -h / | tail -1
echo "== Portlar (4100/4200 boş olmalı) =="; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(4100|4200)\b' || echo "boş"
echo "== .env =="; [ -f .env ] && echo "var" || echo "YOK (cp .env.example .env)"
if [ -f .env ]; then set -a; . ./.env; set +a
  echo "== Mod =="; echo "DRY_RUN=$DRY_RUN LIVE_OUTREACH_ENABLED=$LIVE_OUTREACH_ENABLED EMAIL_PROVIDER=$EMAIL_PROVIDER"
  echo "== Postgres =="; psql "$DATABASE_URL" -c "select current_database(), version();" 2>&1 | head -3
  case "$DATABASE_URL" in *n8n*) echo "UYARI: DATABASE_URL n8n veritabanına işaret ediyor olabilir!";; esac
fi
echo "== Node =="; node -v
