# Models and providers

## Providers (`packages/adapters/src/model`)
- `MODEL_PROVIDER`: `mock` (default, scripted), `anthropic`, `openrouter`, `local` (any OpenAI-compatible server; `LOCAL_BASE_URL`). OpenRouter and local use fetch + SSE with no SDK, `redirect: "error"`, key redaction. Provider SDKs may only be imported inside `packages/adapters` (`pnpm lint:sdk`).
- Configuration is read from `.env` at the repository root; real environment variables win, except that an EMPTY real `FACILITATOR_TOKEN` is treated as unset.
- Errors are typed (`ModelProviderError`: kind, transient, status, retryAfterMs). `RetryingModelProvider` retries only before the first chunk. A reasoning model that spends its budget thinking gives the retryable kind `reasoning_budget`; reasoning text is never shown.

## Environment variables (defaults)
| Variable | Default | Notes |
| --- | --- | --- |
| `NPC_MODEL`, `GM_MODEL`, `EVAL_MODEL` | `claude-sonnet-5.5`; `EVAL_MODEL` falls back to `NPC_MODEL` | `--player-model` picks the player-bot model |
| `NPC_FIRST_TOKEN_TIMEOUT_MS` / `NPC_REPLY_TIMEOUT_MS` | 10000 / 20000 | local `.env` uses 120000 / 240000 for slow local models |
| `NPC_MAX_TOKENS`, `GM_MAX_TOKENS`, `EVAL_MAX_TOKENS` | 600, 400, 3000 | a bigger budget needs a longer first-token timeout (thinking happens before the first word) |
| `NPC_TEMPERATURE`, `PLAYER_TEMPERATURE`, `GM_TEMPERATURE`, `EVAL_TEMPERATURE` | 0.8, 0.9, 0.2, 0.2 | sent only when set |
| `MODEL_MAX_RETRIES`, `MODEL_RETRY_BASE_MS` | 2, 500 | worst case per Game Master evaluation: 2 x (1 + retries) requests inside `GM_TIMEOUT_MS` |
| `GM_TIMEOUT_MS`, `GM_REASK`, `GM_EVERY_N_UTTERANCES`, `GM_TRACE_FILE` | max(reply timeout, 60 s), on, 3, off | trace file must not be a `*.jsonl` in the sessions dir |
| `GM_TRANSCRIPT_WINDOW` | 40 (10..500, >= `GM_EVERY_N_UTTERANCES`) | US-0019: least number of latest scene lines in a Game Master prompt; widened to every line since the last answered prompt of that condition (cap 500, alert beyond), plus the first 2 scene lines and each AI character's last 2 with the line before each; `{"omitted": n}` markers in place |
| `GM_AUTO_RELEASE` | 0 | US-0034: 1 lets the Game Master release an earned fact itself |
| `EVAL_TIMEOUT_MS`, `EVAL_TRANSCRIPT_CHARS` | 180000 | evaluator calls, one per player plus one for the group |
| `FACILITATOR_TOKEN`, `RUNTIME_HOST`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `WS_*` | token unset (server open, loud warning) | see `docs/THREAT_MODEL.md` |
| `SESSION_START`, `SESSION_LOCK_STALE_MS` | `resume`, 30000 (10000 to 600000) | `fresh` moves the old log aside |

## The local endpoint (owner's Mac: Apple M5 Pro, 64 GB)
Osaurus at `http://127.0.0.1:1337/v1`. Models served on 2026-10-06: `foundation`, `gemma-4-31b-it-qat-mxfp4`, `nemotron-3-nano-omni-30b-a3b-jangtq4`, `qwen3.8-27b-mxfp8`, `raptor-v0.5-8b-a1b-jang_6m`.
- **gemma-4-31b-it-qat-mxfp4: use this.** About 18 GB. Full showcase about 400 to 650 s, with the evaluator about 1100 to 1300 s. In role, specific, progresses a negotiation, 0 fallbacks, copies the Game Master nonce every time.
- raptor-v0.5-8b: fast (about 0.6 s warm) but repetitive and self-echoing even with the anti-repeat prompt. Dropped from testing.
- qwen3.8-27b-mxfp8: a reasoning model. 117 s cold and about 20 s warm for 20 tokens; empty replies (budget spent thinking) and first-token timeouts. Needs very long timeouts.
- nemotron-3-nano-omni: fluent but the characters echo each other and the Game Master ran out of reasoning budget.
- foundation: longer replies, 1 fallback, the CFO talks about "the CFO" in the third person.
- Free OpenRouter Nemotron: about 40% overload errors; the retry layer gave 0 of 20 fallbacks (single run).
- Candidate second models (surveyed on Hugging Face 2026-10-06, not yet downloaded): Ministral-3-14B-Instruct-2512 (non-reasoning, Mistral family), gpt-oss-20b MXFP4 (reasoning, fast), Qwen3.6-35B-A3B 4-bit (thinking on by default; `chat_template_kwargs.enable_thinking=false` is not sent by our provider yet), Nemotron-3.5-Lightning-30B-A3B. A different family from Gemma is wanted as an independent Game Master and evaluator.

## Cost
`docs/AI_COST_LOG.md` is appended by the Stop hook with running totals per snapshot: do not sum rows; take the latest row per session.
