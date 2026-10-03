#!/usr/bin/env bash
# Architecture §9 rule 1: nothing outside packages/adapters may use a provider SDK.
# Scans source files (static/side-effect/dynamic imports, require) and every
# package.json dependency block. Usage: check-sdk-imports.sh [root-dir]
set -uo pipefail
cd "${1:-.}"

PKG='(@anthropic-ai/[A-Za-z0-9._-]+|openai|@google/generative-ai|@google/genai|@google-cloud/vertexai|@aws-sdk/client-bedrock-runtime|cohere-ai|@mistralai/[A-Za-z0-9._-]+)'
CODE_RE="(from|import|require)[[:space:]]*\\(?[[:space:]]*['\"]${PKG}(/[^'\"]*)?['\"]"
JSON_RE="\"${PKG}\"[[:space:]]*:"

find_files() {
  find . \( -name node_modules -o -name dist -o -name .superpowers -o -name .git -o -name coverage -o -path ./packages/adapters \) -prune -o \
    -type f \( "$@" \) -print
}

status=0
code_hits=$(find_files -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \
  | xargs grep -nE "$CODE_RE" 2>/dev/null || true)
json_hits=$(find_files -name package.json | xargs grep -nE "$JSON_RE" 2>/dev/null || true)

if [ -n "$code_hits$json_hits" ]; then
  [ -n "$code_hits" ] && echo "$code_hits"
  [ -n "$json_hits" ] && echo "$json_hits"
  echo "provider SDK used outside packages/adapters (Architecture §9 rule 1)" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "sdk-imports: ok"
exit "$status"
