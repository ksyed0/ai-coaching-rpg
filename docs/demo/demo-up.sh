#!/usr/bin/env bash
# Client-demo launcher: control service (8787) + built web app (3000), all on loopback.
#   docs/demo/demo-up.sh          check everything, then start (Ctrl-C stops both)
#   docs/demo/demo-up.sh check    only the pre-flight checks
#   docs/demo/demo-up.sh secret   copy the console sign-in secret to the clipboard (never printed)
#   docs/demo/demo-up.sh links <session-id>   print the player join URLs for a session (no codes: those are typed)
# Secrets are generated ONCE into ~/.scenecoach/demo.env (mode 600) and reused, because new
# COOKIE_KEYS would sign every seated player out. Model settings come from the root .env
# (symlinked into this worktree); the control service reads it, the runtimes get it from there.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
STATE="$HOME/.scenecoach"
SECRETS="$STATE/demo.env"
mkdir -p "$STATE/logs" "$STATE/control"
chmod 700 "$STATE"

die() { echo "FAIL: $*" >&2; exit 1; }
ok()  { echo "ok:   $*"; }

if [ ! -f "$SECRETS" ]; then
  (umask 077; {
    echo "LAUNCHER_TOKEN=$(openssl rand -hex 32)"
    echo "FACILITATOR_SECRET=$(openssl rand -hex 12)"
    echo "COOKIE_KEYS=k1:$(openssl rand -base64 32)"
  } > "$SECRETS")
  ok "generated demo secrets in $SECRETS"
fi
chmod 600 "$SECRETS"

if [ "${1:-}" = "secret" ]; then
  grep '^FACILITATOR_SECRET=' "$SECRETS" | cut -d= -f2- | tr -d '\n' | pbcopy
  echo "console sign-in secret copied to the clipboard"; exit 0
fi

if [ "${1:-}" = "links" ]; then
  [ -n "${2:-}" ] || die "usage: demo-up.sh links <session-id>   (the id is in the console URL: /console/<id>)"
  for r in delivery_lead account_manager tech_lead; do
    echo "$r: http://localhost:3000/join?session=$2&role=$r"
  done
  echo "(tech_lead is the AI player in the demo: nobody joins it.) Each human also needs their own code from the console."
  exit 0
fi

# ---- pre-flight -------------------------------------------------------------------------------
[ -e .env ] || die ".env is missing in this worktree (ln -s ~/Projects/ai-coaching-rpg/.env .env)"
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PROVIDER="$(get MODEL_PROVIDER)"; BASE="$(get LOCAL_BASE_URL)"; NPC="$(get NPC_MODEL)"; GM="$(get GM_MODEL)"
[ "$PROVIDER" = "local" ] || die "MODEL_PROVIDER is '$PROVIDER' (expected local; mock replies are '[mock reply]')"
ok "model provider local, NPC=$NPC GM=$GM"
MODELS="$(curl -s -m 8 "$BASE/models" || true)"
echo "$MODELS" | grep -q "\"$NPC\"" || die "LM Studio at $BASE is not reachable or does not list $NPC"
ok "LM Studio reachable, $NPC listed"
T0=$(date +%s)
curl -s -m 120 "$BASE/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$NPC\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"max_tokens\":400}" \
  | grep -q '"content"' || die "test completion failed"
ok "test completion answered in $(( $(date +%s) - T0 )) s (loads the model if idle)"
[ -d apps/web/.next ] || die "web app is not built (pnpm --filter @acr/web build)"
[ "$(git log -1 --format=%ct)" -le "$(stat -f %m apps/web/.next/BUILD_ID)" ] || ok "WARNING: web build older than HEAD commit, rebuild if unsure"
for p in 3000 8787; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && die "port $p is already in use"; done
ok "ports 3000 and 8787 free"
[ "${1:-}" = "check" ] && { echo "pre-flight passed"; exit 0; }

# ---- start --------------------------------------------------------------------------------------
# A clean environment for the children: nothing from this shell's ANTHROPIC_* / OPENROUTER_* leaks in.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN OPENROUTER_API_KEY
set -a; . "$SECRETS"; set +a
export CONTROL_DATA_DIR="$STATE/control"
export LAUNCHER_URL="http://127.0.0.1:8787"
export PUBLIC_ORIGIN="http://localhost:3000"

pnpm control > "$STATE/logs/control.log" 2>&1 &
CONTROL_PID=$!
trap 'kill $CONTROL_PID 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 40); do
  curl -s -o /dev/null -m 1 "$LAUNCHER_URL/" && break; kill -0 $CONTROL_PID 2>/dev/null || die "control service exited (see $STATE/logs/control.log)"; sleep 1
done
ok "control service up (log: $STATE/logs/control.log)"
echo
echo "Open  http://localhost:3000/console   (exactly 'localhost', never 127.0.0.1)"
echo "Secret: run  docs/demo/demo-up.sh secret  in another terminal (copies to clipboard)"
echo
pnpm --filter @acr/web start -H 127.0.0.1
