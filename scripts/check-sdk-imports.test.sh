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
run livekit-server-in-service      services/a/x.ts 'import { AccessToken } from "livekit-server-sdk";' 1
run livekit-server-in-adapters     packages/adapters/src/x.ts 'import { AccessToken } from "livekit-server-sdk";' 0
run livekit-server-pkgjson-web     apps/web/package.json '{"dependencies":{"livekit-server-sdk":"2.19.2"}}' 1
run rtc-node-in-speech             services/speech/src/x.ts 'import { Room } from "@livekit/rtc-node";' 0
run rtc-node-in-control            services/control/src/x.ts 'import { Room } from "@livekit/rtc-node";' 1
run rtc-node-pkgjson-adapters      packages/adapters/package.json '{"dependencies":{"@livekit/rtc-node":"1.2.1"}}' 1
run livekit-client-in-web          apps/web/src/x.tsx 'import { Room } from "livekit-client";' 0
run livekit-client-in-control      services/control/src/x.ts 'import { Room } from "livekit-client";' 1
run livekit-client-dynamic-import-in-runtime services/runtime/src/x.ts 'const m = await import("livekit-client");' 1
run livekit-protocol-untouched     services/a/x.ts 'import "@livekit/protocol";' 0
run adapters-livekit-subpath-in-control services/control/src/x.ts 'import { mintParticipantToken } from "@acr/adapters/livekit";' 0
run adapters-livekit-in-speech            services/speech/src/x.ts 'import { mintWorkerToken } from "@acr/adapters/livekit";' 1
run adapters-livekit-identity-in-speech   services/speech/src/x.ts 'import { parseParticipantIdentity } from "@acr/adapters/livekit/identity";' 0
run adapters-livekit-identity-in-control  services/control/src/x.ts 'import { participantIdentity } from "@acr/adapters/livekit/identity";' 0
run adapters-livekit-token-subpath-runtime services/runtime/src/x.ts 'const m = await import("@acr/adapters/livekit/token");' 1
run adapters-livekit-require-in-web       apps/web/src/x.ts "const a = require('@acr/adapters/livekit');" 1
run adapters-livekit-live-test-in-speech  services/speech/src/__tests__/livekit.live.test.ts 'import { mintWorkerToken } from "@acr/adapters/livekit";' 0
run adapters-livekit-other-test-in-speech services/speech/src/__tests__/ingest.test.ts 'import { mintWorkerToken } from "@acr/adapters/livekit";' 1
run adapters-livekitish-untouched         services/speech/src/x.ts 'import { x } from "@acr/adapters/livekitish";' 0
exit "$fail"
