#!/usr/bin/env bash
# Tests run.sh's facilitator token handling with a stubbed `docker`. Run: bash scripts/run-sh-token.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
ok()  { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

setup() { # prints the temp dir
  local d; d=$(mktemp -d); mkdir -p "$d/bin" "$d/deploy/compose"
  cp "$here/run.sh" "$here/.env.example" "$d/"
  printf '#!/bin/sh\nexit 0\n' > "$d/bin/docker"; chmod +x "$d/bin/docker"
  echo "$d"
}
run() { (cd "$1" && PATH="$1/bin:$PATH" bash ./run.sh 2>&1); }

# 1. A new .env gets a random token of at least 16 characters, and the output never shows it.
d=$(setup); out=$(run "$d")
token=$(sed -n 's/^FACILITATOR_TOKEN=//p' "$d/.env")
[ "${#token}" -ge 16 ] && ok "new .env gets a token" || bad "new .env gets a token (got '${#token}' chars)"
case "$out" in *"$token"*) bad "the token was printed" ;; *) ok "the token is not printed" ;; esac
case "$out" in *"stored in .env"*) ok "says where the token is" ;; *) bad "does not say where the token is" ;; esac
[ "$(grep -c '^FACILITATOR_TOKEN=' "$d/.env")" = 1 ] && ok "exactly one token line" || bad "token line count"
# GNU stat first: on Linux `stat -f` means file-system status and would print a multi-line dump. BSD/macOS stat has no -c.
mode=$(stat -c '%a' "$d/.env" 2>/dev/null || stat -f '%Lp' "$d/.env")
case "$mode" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;; *) bad "could not read the .env mode (got '$mode')"; mode=unknown ;; esac
[ "$mode" = 600 ] && ok ".env is mode 600" || bad ".env mode is $mode"
ls "$d" | grep -q '^\.env\.new' && bad "a temporary .env file was left behind" || ok "no temporary file left behind"
rm -rf "$d"

# 2. Two new installs get different tokens.
d1=$(setup); d2=$(setup); run "$d1" >/dev/null; run "$d2" >/dev/null
t1=$(sed -n 's/^FACILITATOR_TOKEN=//p' "$d1/.env"); t2=$(sed -n 's/^FACILITATOR_TOKEN=//p' "$d2/.env")
[ -n "$t1" ] && [ "$t1" != "$t2" ] && ok "tokens differ between installs" || bad "tokens are not random"
rm -rf "$d1" "$d2"

# 3. An existing .env is never rewritten, and an existing token is kept.
d=$(setup); printf 'MODEL_PROVIDER=mock\nFACILITATOR_TOKEN=my-own-token-0123456789\n' > "$d/.env"; before=$(cat "$d/.env")
out=$(run "$d")
[ "$(cat "$d/.env")" = "$before" ] && ok "existing .env with a token is untouched" || bad "existing .env was changed"
case "$out" in *OPEN*) bad "warned although a token exists" ;; *) ok "no open-server warning when a token exists" ;; esac
rm -rf "$d"

# 4. An existing .env without a token is not modified either, but the user is warned.
d=$(setup); printf 'MODEL_PROVIDER=mock\n' > "$d/.env"; before=$(cat "$d/.env")
out=$(run "$d")
[ "$(cat "$d/.env")" = "$before" ] && ok "existing .env without a token is untouched" || bad "existing .env was changed"
case "$out" in *"server is OPEN"*) ok "warns that the server is open" ;; *) bad "no warning for a token-less .env" ;; esac
rm -rf "$d"
# 5. FACILITATOR_TOKEN= and FACILITATOR_TOKEN="" in an existing .env count as unset (warning), a quoted value counts as set.
for v in 'FACILITATOR_TOKEN=' 'FACILITATOR_TOKEN=""' "FACILITATOR_TOKEN=''"; do
  d=$(setup); printf 'MODEL_PROVIDER=mock\n%s\n' "$v" > "$d/.env"; out=$(run "$d")
  case "$out" in *"server is OPEN"*) ok "empty token ($v) warns" ;; *) bad "empty token ($v) did not warn" ;; esac
  rm -rf "$d"
done
d=$(setup); printf 'FACILITATOR_TOKEN="quoted-token-0123456789"\n' > "$d/.env"; out=$(run "$d")
case "$out" in *"server is OPEN"*) bad "a quoted token warned" ;; *) ok "a quoted token does not warn" ;; esac
rm -rf "$d"

# 6. A symlinked .env is never written through (and a dangling one is not replaced).
d=$(setup); printf 'MODEL_PROVIDER=mock\n' > "$d/real.env"; ln -s real.env "$d/.env"; out=$(run "$d")
[ "$(cat "$d/real.env")" = "MODEL_PROVIDER=mock" ] && ok "symlink target untouched" || bad "symlink target was modified"
case "$out" in *"symbolic link"*) ok "warns about the symlink" ;; *) bad "no symlink warning" ;; esac
rm -rf "$d"
d=$(setup); ln -s does-not-exist.env "$d/.env"; run "$d" >/dev/null
[ -L "$d/.env" ] && [ ! -e "$d/does-not-exist.env" ] && ok "dangling symlink not replaced or created through" || bad "dangling symlink was touched"
rm -rf "$d"
exit "$fail"
