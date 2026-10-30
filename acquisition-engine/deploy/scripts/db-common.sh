#!/usr/bin/env bash
# D5: backup/restore ortak güvenlik yardımcıları. Kaynak alınır (source), tek başına çalışmaz.
# - URL parolası (ham/percent-encoded VE çözülmüş biçimi) hiçbir çıktıya yazılmaz; eşleme düz metin, regex değil,
# - hedef veritabanı adı gerçek current_database() ile EXPECTED_DB_NAME'e karşı doğrulanır,
# - adı n8n içeren (büyük/küçük harf duyarsız) hedef her zaman reddedilir.
# URL ayrıştırma parametre genişletmesiyle yapılır (sed/regex yok); parola percent-encoded olmalıdır (libpq kuralı).
set -euo pipefail

# scheme://userinfo@hostpath  → parçalar
_url_rest() { printf '%s' "${1#*://}"; }
url_scheme() { printf '%s' "${1%%://*}"; }
url_userinfo() { local rest; rest="$(_url_rest "$1")"; case "$rest" in *@*) printf '%s' "${rest%@*}";; *) printf '';; esac; }
url_hostpath() { local rest; rest="$(_url_rest "$1")"; case "$rest" in *@*) printf '%s' "${rest##*@}";; *) printf '%s' "$rest";; esac; }
url_user() { local ui; ui="$(url_userinfo "$1")"; printf '%s' "${ui%%:*}"; }
url_password() { local ui; ui="$(url_userinfo "$1")"; case "$ui" in *:*) printf '%s' "${ui#*:}";; *) printf '';; esac; }
# percent-encoded parolanın çözülmüş biçimi (psql/libpq hata mesajlarında bu biçim görünebilir)
url_password_decoded() { local pw; pw="$(url_password "$1")"; if [ -n "$pw" ]; then printf '%b' "${pw//%/\\x}"; fi; }
url_db_name() { local hp; hp="$(url_hostpath "$1")"; hp="${hp#*/}"; printf '%s' "${hp%%\?*}"; }

mask_url() {
  local url="$1" pw; pw="$(url_password "$url")"
  if [ -z "$pw" ]; then printf '%s' "$url"; return; fi
  printf '%s://%s:***@%s' "$(url_scheme "$url")" "$(url_user "$url")" "$(url_hostpath "$url")"
}

# stdin'deki parolaları (ham ve çözülmüş) '***' ile değiştirir. awk index() ile düz metin eşleme; regex/sed özel karakterleri etkisiz.
redact() {
  local raw dec; raw="$(url_password "${1:-}")"; dec="$(url_password_decoded "${1:-}")"
  if [ -z "$raw" ]; then cat; return; fi
  RAW_PW="$raw" DEC_PW="$dec" awk '
    function repl(s, pw,   out, i) { if (pw == "") return s; out = ""; while ((i = index(s, pw)) > 0) { out = out substr(s, 1, i - 1) "***"; s = substr(s, i + length(pw)) } return out s }
    { line = $0; line = repl(line, ENVIRON["RAW_PW"]); if (ENVIRON["DEC_PW"] != ENVIRON["RAW_PW"]) line = repl(line, ENVIRON["DEC_PW"]); print line }'
}

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

# verify_dump_checksum DUMP → 0 eşleşiyorsa. SEÇİLEN dosyanın sha256'sı, DUMP.sha256 içindeki özetle karşılaştırılır;
# .sha256 içindeki dosya ADI dikkate alınmaz (yanlış/eski ada güvenilmez).
verify_dump_checksum() {
  local dump="$1" expected actual
  [ -f "$dump.sha256" ] || { echo "DURDURULDU: sağlama dosyası yok ($dump.sha256). Doğrulanamayan yedek geri yüklenmez." >&2; return 3; }
  expected="$(head -n1 "$dump.sha256" | cut -d' ' -f1 | tr 'A-F' 'a-f')"
  case "$expected" in *[!0-9a-f]*|'') echo "DURDURULDU: sağlama dosyası geçersiz biçimde." >&2; return 3;; esac
  [ "${#expected}" -eq 64 ] || { echo "DURDURULDU: sağlama dosyası geçersiz biçimde." >&2; return 3; }
  actual="$(sha256sum "$dump" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || { echo "DURDURULDU: sağlama uyuşmuyor, dosya bozuk veya değiştirilmiş ($(basename "$dump"))." >&2; return 3; }
}
