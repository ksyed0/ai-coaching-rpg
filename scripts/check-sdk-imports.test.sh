#!/usr/bin/env bash
# Throwaway-fixture test for check-sdk-imports.sh. Run: bash scripts/check-sdk-imports.test.sh
set -uo pipefail
script="$(cd "$(dirname "$0")" && pwd)/check-sdk-imports.sh"
fail=0
run() { # name, file, content, expect(0|1)
  local d; d=$(mktemp -d); mkdir -p "$d/$(dirname "$2")"; printf '%s\n' "$3" > "$d/$2"
  bash "$script" "$d" >/dev/null 2>&1; local rc=$?; rm -rf "$d"
  if [ "$rc" -ne "$4" ]; then echo "FAIL: $1 (exit $rc, wanted $4)"; fail=1; else echo "ok: $1"; fi
}
run static            services/a/x.ts   'import A from "@anthropic-ai/sdk";' 1
run side-effect       services/a/x.ts   'import "openai";' 1
run dynamic           services/a/x.ts   'const m = await import("@google/genai");' 1
run require           services/a/x.js   "const o = require('openai');" 1
run bedrock-sdk       packages/b/x.ts   'import B from "@anthropic-ai/bedrock-sdk";' 1
run subpath           packages/b/x.ts   'import B from "openai/resources";' 1
run tsx               services/a/x.tsx  'import A from "@mistralai/mistralai";' 1
run mjs               tools/x.mjs       "import C from 'cohere-ai';" 1
run pkgjson-dep       services/a/package.json '{"dependencies":{"@anthropic-ai/sdk":"^0.30.0"}}' 1
run pkgjson-root-dev  package.json      '{"devDependencies":{"openai":"^4"}}' 1
run adapters-allowed  packages/adapters/src/x.ts 'import A from "@anthropic-ai/sdk";' 0
run adapters-pkgjson  packages/adapters/package.json '{"dependencies":{"@anthropic-ai/sdk":"^0.30.0"}}' 0
run node_modules-skip node_modules/x/y.js "require('openai')" 0
run clean             services/a/x.ts   'import fs from "node:fs"; const openaiish = 1;' 0
exit "$fail"
