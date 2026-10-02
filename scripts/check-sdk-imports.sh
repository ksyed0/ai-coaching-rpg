#!/usr/bin/env bash
# Fails if any file outside packages/adapters imports a provider SDK.
set -euo pipefail
if grep -rn --include='*.ts' -E "from ['\"](@anthropic-ai/sdk|openai|@aws-sdk/client-bedrock-runtime|@google-cloud/vertexai)" packages services 2>/dev/null | grep -v '^packages/adapters/'; then
  echo "provider SDK imported outside packages/adapters" >&2; exit 1
fi
echo "sdk-imports: ok"
