#!/usr/bin/env bash
# Tests run.sh --fresh (US-0018) with stubbed `docker` and `pnpm`/`node`. Run: bash scripts/run-sh-fresh.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
setup() {
  local d; d=$(mktemp -d); mkdir -p "$d/bin" "$d/deploy/compose"
  cp "$here/run.sh" "$here/.env.example" "$d/"
  printf 'FACILITATOR_TOKEN=already-set-0123456789\n' > "$d/.env"
  # docker: report each compose call and the SESSION_START it would see.
  printf '#!/bin/sh\n[ "$1" = "compose" ] && [ "$2" = "version" ] && exit 0\necho "docker $* SESSION_START=${SESSION_START:-unset}"\n' > "$d/bin/docker"
  printf '#!/bin/sh\n[ "$1" = "-p" ] && echo 22 && exit 0\n[ "$1" = "-v" ] && echo v22.0.0\nexit 0\n' > "$d/bin/node"
  printf '#!/bin/sh\n[ "$1" = "install" ] && exit 0\necho "pnpm $* SESSION_START=${SESSION_START:-unset}"\n' > "$d/bin/pnpm"
  chmod +x "$d/bin/"*
  echo "$d"
}
check() { # name, args, expected substring
  local d out; d=$(setup)
  out=$(cd "$d" && env -u SESSION_START PATH="$d/bin:$PATH" bash ./run.sh $2 2>&1)
  rm -rf "$d"
  case "$out" in *"$3"*) echo "ok: $1" ;; *) echo "FAIL: $1 (wanted '$3' in: $out)"; fail=1 ;; esac
}
check "docker, no flag: compose up, resume by default"  ""               "up --build SESSION_START=unset"
check "docker --fresh: a one-off run with SESSION_START=fresh" "--fresh" "run --rm --service-ports -e SESSION_START=fresh runtime"
check "docker --fresh builds first"                      "--fresh"        "compose -f deploy/compose/docker-compose.yml build"
check "dev, no flag: resume by default"                  "--dev"          "pnpm dev:runtime SESSION_START=unset"
check "dev --fresh exports SESSION_START=fresh"          "--dev --fresh"  "pnpm dev:runtime SESSION_START=fresh"
check "flags in either order"                            "--fresh --dev"  "pnpm dev:runtime SESSION_START=fresh"
check "a repeated flag is refused"                       "--fresh --fresh" "--fresh was given twice"
check "an unknown flag is refused"                       "--resume"       "unknown argument: --resume"
check "three arguments are refused"                      "--dev --fresh --dev" "too many arguments"
exit "$fail"
