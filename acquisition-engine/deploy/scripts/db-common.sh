#!/usr/bin/env bash
# D5: backup/restore ortak güvenlik yardımcıları. Kaynak alınır (source), tek başına çalışmaz.
# - URL parolası hiçbir çıktıya yazılmaz (mask_url / redact),
# - hedef veritabanı adı gerçek current_database() ile EXPECTED_DB_NAME'e karşı doğrulanır,
# - adı n8n içeren (büyük/küçük harf duyarsız) hedef her zaman reddedilir.
set -euo pipefail

mask_url() { printf '%s' "$1" | sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#'; }
url_password() { printf '%s' "$1" | sed -nE 's#^[a-z]+://[^:/@]*:([^@]*)@.*$#\1#p'; }
# stdout/stderr içinden parolayı siler (parola boşsa dokunmaz)
redact() { local pw; pw="$(url_password "${1:-}")"; if [ -n "$pw" ]; then sed -e "s#${pw//#/\\#}#***#g"; else cat; fi; }
url_db_name() { printf '%s' "$1" | sed -nE 's#^[a-z]+://[^/]+/([^?]+).*$#\1#p'; }

# assert_db_identity URL EXPECTED  → 0 uygunsa; aksi hâlde mesaj (maskeli) ve çıkış 2
assert_db_identity() {
  local url="$1" expected="$2" masked name_in_url actual
  masked="$(mask_url "$url")"
  name_in_url="$(url_db_name "$url")"
  if printf '%s' "$name_in_url" | grep -qi 'n8n'; then echo "DURDURULDU: hedef ($masked) n8n veritabanına benziyor." >&2; return 2; fi
  actual="$(psql "$url" -Atqc 'SELECT current_database();' 2> >(redact "$url" >&2))" || { echo "DURDURULDU: hedefe bağlanılamadı ($masked)." >&2; return 2; }
  if printf '%s' "$actual" | grep -qi 'n8n'; then echo "DURDURULDU: gerçek veritabanı adı '$actual' n8n içeriyor." >&2; return 2; fi
  if [ "$actual" != "$expected" ]; then echo "DURDURULDU: gerçek veritabanı '$actual', beklenen '$expected' değil (EXPECTED_DB_NAME)." >&2; return 2; fi
  echo "Hedef doğrulandı: $masked (veritabanı: $actual)"
}
