#!/usr/bin/env bash
# Yedekten geri yükleme (D5). DİKKAT: hedefteki mevcut nesneleri değiştirir (pg_restore --clean).
# Kullanım: deploy/scripts/restore.sh <dump> [--target <DATABASE_URL>] [--yes]
#   --target : varsayılan DATABASE_URL yerine hedef (gerçek veritabanı adı yine EXPECTED_DB_NAME olmalı)
#   --yes    : etkileşimsiz onay (yalnız otomasyon/test için)
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
. deploy/scripts/db-common.sh
DUMP="${1:?yedek dosyası gerekli}"; shift || true
TARGET="${DATABASE_URL:-}"; YES=0
while [ $# -gt 0 ]; do case "$1" in --target) TARGET="$2"; shift 2;; --yes) YES=1; shift;; *) echo "Bilinmeyen seçenek: $1" >&2; exit 1;; esac; done
: "${TARGET:?hedef DATABASE_URL gerekli}"
EXPECTED_DB_NAME="${EXPECTED_DB_NAME:-bays_acq}"

# 1) Dosya bütünlüğü: sağlama dosyası ZORUNLU ve eşleşmeli
[ -f "$DUMP" ] || { echo "DURDURULDU: yedek dosyası yok: $DUMP" >&2; exit 3; }
[ -f "$DUMP.sha256" ] || { echo "DURDURULDU: sağlama dosyası yok ($DUMP.sha256). Doğrulanamayan yedek geri yüklenmez." >&2; exit 3; }
( cd "$(dirname "$DUMP")" && sha256sum -c --quiet "$(basename "$DUMP").sha256" ) || { echo "DURDURULDU: sağlama uyuşmuyor, dosya bozuk veya değiştirilmiş." >&2; exit 3; }
pg_restore --list "$DUMP" > /dev/null || { echo "DURDURULDU: yedek okunamıyor (pg_restore --list)." >&2; exit 3; }

# 2) Hedef kimliği (n8n reddi + beklenen ad), çıktıda parola yok
assert_db_identity "$TARGET" "$EXPECTED_DB_NAME"

# 3) Açık onay (maskeli hedef)
if [ "$YES" -ne 1 ]; then
  read -r -p "Hedef: $(mask_url "$TARGET") — mevcut veriler değiştirilecek. Devam? (yes/no) " ok
  [ "$ok" = "yes" ] || { echo "İptal edildi."; exit 1; }
fi
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$DUMP" 2> >(redact "$TARGET" >&2)
echo "Geri yükleme tamamlandı: $(mask_url "$TARGET"). API'yi yeniden başlatın ve panelden Sistem sayfasını kontrol edin."
