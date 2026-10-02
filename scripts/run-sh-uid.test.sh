#!/usr/bin/env bash
# Tests run.sh's HOST_UID/HOST_GID decision with stubbed `id` and `docker`. Run: bash scripts/run-sh-uid.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
check() { # name, fake-uid, fake-gid, "env assignments", expected "UID GID"
  local d; d=$(mktemp -d); mkdir -p "$d/bin"
  cp "$here/run.sh" "$here/.env.example" "$d/"; mkdir -p "$d/deploy/compose"
  printf '#!/bin/sh\nif [ "$1" = "-u" ]; then echo %s; else echo %s; fi\n' "$2" "$3" > "$d/bin/id"
  printf '#!/bin/sh\n[ "$1" = "compose" ] && [ "$2" = "version" ] && exit 0\necho "UID=$HOST_UID GID=$HOST_GID"\n' > "$d/bin/docker"
  chmod +x "$d/bin/id" "$d/bin/docker"
  local out; out=$(cd "$d" && env -u HOST_UID -u HOST_GID $4 PATH="$d/bin:$PATH" bash ./run.sh 2>/dev/null | grep '^UID=')
  rm -rf "$d"
  if [ "$out" != "UID=$5" ]; then echo "FAIL: $1 (got '$out', wanted 'UID=$5')"; fail=1; else echo "ok: $1"; fi
}
check "normal user keeps own ids"          501 20 ""                          "501 GID=20"
check "root falls back to 1000:1000"       0   0  ""                          "1000 GID=1000"
check "root with explicit ids keeps them"  0   0  "HOST_UID=1234 HOST_GID=5678" "1234 GID=5678"
check "user with explicit ids keeps them"  501 20 "HOST_UID=1234 HOST_GID=5678" "1234 GID=5678"
exit "$fail"
