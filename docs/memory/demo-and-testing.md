# Demo, checks and testing

## `pnpm demo` (services/runtime/src/demo)
| Command | What it runs | Checks |
| --- | --- | --- |
| `pnpm demo --fast` | mock main story, offline, deterministic | 29 (F-01..F-29) |
| `pnpm demo --showcase --fast` | extended 6-scene scenario with scripted players | 14 (S-01..S-14) |
| `... --showcase --fast --evaluate` | + the evaluator and S-16 | 15 |
| `pnpm demo --fast --security` | opt-in security room | 32 (F-31..F-33 added) |
| `pnpm demo --fast --resume` | opt-in resume room (simulated crash, restart) | 39 (42 with `--security`) |
| `... --live` | the same against the configured real model | live runs skip some checks; F-08 reports canned fallback lines (US-0023) |
| `--players generated` | player bots written by the model; intents logged in the transcript (`--no-intents` hides) | S-15 audits the prompts |
| `--gm-trace f.log --min-gm-exits n [--max-false-exits n]` | live Game Master measurement, check S-18 | n is gated only when asked |
Also `--url ws://...` (test a running server; `FACILITATOR_TOKEN` env passes a token), `--json -` (pure JSON on stdout), `--transcript file.md` (tags `[SCRIPTED] [GENERATED] [FALLBACK] [UNVERIFIED] [SYSTEM]`), `--watchdog <minutes 1..180>`, `--speed`, `--max-lines`.
`--max-fallbacks <n>` (0..1000) works for the 29-check run (check F-08 fails above n; without it the count is a WARNING in F-08) and for `--showcase` (S-05). The JSON report of the main story has `liveEvidence` (counts, per-character, sanitized alerts with `replySeq`; a mock run reports 0 of 4). Alert text goes through `sanitizeAlert` (live-evidence.ts: secrets, join codes, key shapes, hidden-fact fragments, 300 chars) before narration, report and transcript. The showcase narration still prints its alerts with `clip` only.
Check counts are pinned by tests: add a new check only in an opt-in room or by extending an existing check's assertions.

## Other commands
- `pnpm gm-eval` (offline: 14 labelled Game Master cases, 34-entry parser corpus, drift test against `showcase.yaml`), `--live --runs 3`, `--trace file`, `--build tests/gm-cases` (rebuild after editing the showcase script).
- `pnpm evaluate <session.jsonl> [--scenario dir] [--out dir]`: draft BARS feedback reports (default output `data/reports`, git-ignored).
- `pnpm test`, `pnpm test:coverage` (80% gate, packages are about 90 to 97%), `pnpm typecheck`, `pnpm lint:sdk`, `npm run plan:test` (jest), `npm run plan:generate`.

## Live-run recipe (owner's machine)
`NPC_MODEL=gemma-4-31b-it-qat-mxfp4 GM_MODEL=gemma-4-31b-it-qat-mxfp4 pnpm -s demo --showcase --live --players generated --evaluate --eval-out DIR --transcript DIR/t.md --json DIR/r.json` from a worktree that has the `.env`. Output folders live OUTSIDE the repo in `~/Projects/ai-coaching-rpg-demo-output/`. Do not run two live runs at once on the one model server.

## Reference results (Gemma, 2026-10-06/07)
Game Master ended 5 of 6 scenes (4 before US-0016 released the CFO's fact; scene 2 still ends by facilitator advance); `gm-eval --live` x3: 100% usable verdicts, 0 `no_nonce`, 0 of 24 false exits on the negative controls. Evaluator: 3 of 3 players scored, 36 to 42 verbatim quotes, 0 dropped; scores are lenient and close together (needs calibration).

## CI (GitHub Actions)
Required for merge: Lint, Test & Coverage Gate, Build, Orchestrator Validation, Dependency Audit, Secret Scanning, Analyze JavaScript. Also run: Workspace Tests / Typecheck / Audit, SDK Import Guard, Docker Build, Demo Run, CodeQL. Branch protection on `main` and `develop`: PR required, 0 approvals, strict. Merge with `gh pr merge N --merge`. A required check can sit "pending" for a long time when a test hangs: cancel it and read the partial log. "The job was not acquired by Runner" is infrastructure: rerun the failed jobs.

## Reproducing Linux in a container
CI is Ubuntu; macOS passes can hide Linux-only hangs. Docker is installed:
`git archive HEAD | tar -x -C /tmp/x && docker run --rm -v /tmp/x:/w -w /w node:22 bash -c 'corepack enable; corepack prepare pnpm@9 --activate; pnpm install --frozen-lockfile; timeout 90 pnpm -s vitest run <files>'` (run as root and, for permission tests, as a non-root user).
