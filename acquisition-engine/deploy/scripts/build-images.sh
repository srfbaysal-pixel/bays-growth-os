#!/usr/bin/env bash
# K2: Düşük RAM'li sunucu için imaj derleme yardımcısı.
# Varsayılan: imajları BU makinede sırayla derler (her derleme öncesi boş RAM+swap kontrolü).
# --export: imajları tar olarak dışa aktarır (başka makinede derleyip sunucuya taşımak için):
#   build makinesi:  deploy/scripts/build-images.sh --export /tmp/bays-acq-v1-images.tar
#   sunucu:          docker load -i bays-acq-v1-images.tar && docker compose up -d api panel
set -euo pipefail
cd "$(dirname "$0")/../.."
MIN_FREE_MB="${MIN_FREE_MB:-1500}"
check_mem() {
  local avail swap total
  avail=$(free -m | awk '/^Mem:/{print $7}'); swap=$(free -m | awk '/^Swap:/{print $4}'); total=$((avail + swap))
  if [ "$total" -lt "$MIN_FREE_MB" ]; then
    echo "DURDURULDU: boş RAM+swap ${total} MB < ${MIN_FREE_MB} MB. Mevcut servisleri (n8n/Postgres) riske atmamak için derleme yapılmadı."
    echo "Seçenekler: swap ekleyin (fallocate -l 2G /swapfile ...), ya da başka makinede --export ile derleyip 'docker load' ile taşıyın."
    exit 2
  fi
}
export DOCKER_BUILDKIT=1
check_mem; echo "== API imajı"; docker compose build api
check_mem; echo "== Panel imajı"; docker compose build panel
if [ "${1:-}" = "--export" ]; then
  OUT="${2:?çıktı dosyası gerekli}"
  docker save -o "$OUT" bays-acq-v1-api:latest bays-acq-v1-panel:latest
  echo "Dışa aktarıldı: $OUT ($(du -h "$OUT" | cut -f1))"
fi
echo "Tamam. Başlatmak için: docker compose up -d api panel"
