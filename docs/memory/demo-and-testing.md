# Demo, checks and testing

## `pnpm demo` (services/runtime/src/demo)
| Command | What it runs | Checks |
| --- | --- | --- |
| `pnpm demo --fast` | mock main story, offline, deterministic | 29 (F-01..F-29) |
| `pnpm demo --showcase --fast` | extended 6-scene scenario with scripted players | 14 (S-01..S-14) |
| `... --showcase --fast --evaluate` | + the evaluator and S-16 | 15 |
| `pnpm demo --showcase --fast --scenario scenarios/friday-escalation` | the original 3-scene scenario (US-0040; 16 lines, 4 AI replies, 6 GM evaluations, every scene ends by the Game Master; Priya's fact 1 is suggested in scene 2; `--max-lines` must be 2 or more) | 14 (15 with `--evaluate`) |
| `pnpm demo --fast --security` | opt-in security room | 32 (F-31..F-33 added) |
| `pnpm demo --fast --resume` | opt-in resume room (simulated crash, restart) | 39 (42 with `--security`) |
| `... --live` | the same against the configured real model | live runs skip some checks; F-08 reports canned fallback lines (US-0023) |
| `--players generated` | player bots written by the model; intents logged in the transcript (`--no-intents` hides) | S-15 audits the prompts |
| `--gm-trace f.log --min-gm-exits n [--max-false-exits n]` | live Game Master measurement, check S-18 | n is gated only when asked |
`--scenario <dir>` picks the showcase scenario (default `scenarios/friday-escalation-extended`; needs a `showcase.yaml`); use `scenarios/friday-escalation` with `--live --players generated` to capture real excerpts for the esc-scope-creep-01 calibration set. `--max-false-exits` compares labels with `tests/gm-cases`, which holds the extended scenario's cases only (US-0040 did not build cases for the original); `--min-gm-exits` can reach at most 3 for the original (3 scenes). S-14 accepts the facilitator advance only in a scene with no `gm_detects` condition (generic; none of the shipped scenes is one now). Priya (both scenarios) has an `earned_when` for hidden fact 1, suggested in scene 2 of the mock runs; the main 29-check story's scripted Game Master has one extra false verdict for it.
Also `--url ws://...` (test a running server; `FACILITATOR_TOKEN` env passes a token), `--json -` (pure JSON on stdout), `--transcript file.md` (tags `[SCRIPTED] [GENERATED] [FALLBACK] [UNVERIFIED] [SYSTEM]`), `--watchdog <minutes 1..180>`, `--speed`, `--max-lines`.
`--max-fallbacks <n>` (0..1000) works for the 29-check run (check F-08 fails above n; without it the count is a WARNING in F-08) and for `--showcase` (S-05). The JSON report of the main story has `liveEvidence` (counts, per-character, sanitized alerts with `replySeq`; a mock run reports 0 of 4). Alert text goes through `sanitizeAlert` (live-evidence.ts) in the 29-check run and the showcase (narration, report, transcript, F-13/lab failure messages): control chars to `·`, invisible chars removed, secrets, join codes in every accepted spelling, Bearer values, opaque tokens and hidden-fact text (case/width/zero-width folded) to `[redacted]`, 300 chars. An alert links to a reply (`replySeq`) only when it caused it, else null (orphan, still listed).
Check counts are pinned by tests: add a new check only in an opt-in room or by extending an existing check's assertions.

## Other commands
- `pnpm gm-eval` (offline: 14 labelled Game Master cases, 34-entry parser corpus, drift test against `showcase.yaml`), `--live --runs 3`, `--trace file`, `--build tests/gm-cases` (rebuild after editing the showcase script).
- `pnpm evaluate <session.jsonl> [--scenario dir] [--out dir]`: draft BARS feedback reports (default output `data/reports`, git-ignored).
- `pnpm calibrate --scenario scenarios/friday-escalation [--judge second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1] [--repeat n] [--only ids] [--strict]`: score the probes with real judges (output `data/calibration`, git-ignored); `MODEL_PROVIDER=mock` is refused (exit 2), tests inject fake judges instead.
- `pnpm calibrate draft|excerpt|approve|assign-splits --scenario <dir> ...` (US-0037): drafts go to the git-ignored `calibration/drafts/`; tests use the scripted drafter in `services/runtime/src/calibration/__tests__/fake-drafter.ts` (no live calls); `approve` is the owner's command, never run by an agent.
- `pnpm test`, `pnpm test:coverage` (80% gate, packages are about 90 to 97%), `pnpm typecheck`, `pnpm lint:sdk`, `npm run plan:test` (jest), `npm run plan:generate`.

## Live-run recipe (owner's machine)
`NPC_MODEL=gemma-4-31b-it-qat-mxfp4 GM_MODEL=gemma-4-31b-it-qat-mxfp4 pnpm -s demo --showcase --live --players generated --evaluate --eval-out DIR --transcript DIR/t.md --json DIR/r.json` from a worktree that has the `.env`. Output folders live OUTSIDE the repo in `~/Projects/ai-coaching-rpg-demo-output/`. Do not run two live runs at once on the one model server.

## Reference results (Gemma, 2026-10-06/07)
Game Master ended 5 of 6 scenes (4 before US-0016 released the CFO's fact; scene 2 still ends by facilitator advance); `gm-eval --live` x3: 100% usable verdicts, 0 `no_nonce`, 0 of 24 false exits on the negative controls. Evaluator: 3 of 3 players scored, 36 to 42 verbatim quotes, 0 dropped; scores are lenient and close together (needs calibration).

Live Gemma showcase (generated players, `--evaluate`), 2026-10-07: after US-0033 (develop@cb6a479) 15 passed / 0 failed / 2 skipped, 1449 s, 16 of 16 AI replies real (0 fallbacks, median 17 to 18 s), the Game Master ended 4 of 6 scenes (scenes 2 and 5 by facilitator advance), 14 evaluations with 0 unusable verdicts; after US-0034 (develop@70b3f21) 15 / 0 / 2, 1078 s, 10 of 10 replies real, the Game Master ended 5 of 6 scenes, 11 evaluations, 0 re-asks, and in scene 4 it suggested `/release cfo 1` to the facilitator only (the CFO's `earned_when` condition: a fixed fee tied to a firm date). The scene count varies between runs because the generated players differ; compare over several runs, not one.

US-0019 comparison (Gemma, live showcase with generated players, no evaluator, one run at a time, 2026-10-07): Game Master scenes ended per run: `develop` 4, 4, 4 (always scenes 1, 3, 4, 6; scenes 2 and 5 by facilitator advance); branch `feature/EPIC-0006-US-0019-model-cost` 5, 4, 4; 0 canned fallbacks in all six; 640 to 822 s per run. Compare over several runs: one run varies by about one scene.

## CI (GitHub Actions)
Required for merge: Lint, Test & Coverage Gate, Build, Orchestrator Validation, Dependency Audit, Secret Scanning, Analyze JavaScript. Also run: Workspace Tests / Typecheck / Audit, SDK Import Guard, Docker Build, Demo Run, CodeQL. Branch protection on `main` and `develop`: PR required, 0 approvals, strict. Merge with `gh pr merge N --merge`. A required check can sit "pending" for a long time when a test hangs: cancel it and read the partial log. "The job was not acquired by Runner" is infrastructure: rerun the failed jobs.

## Reproducing Linux in a container
CI is Ubuntu; macOS passes can hide Linux-only hangs. Docker is installed:
`git archive HEAD | tar -x -C /tmp/x && docker run --rm -v /tmp/x:/w -w /w node:22 bash -c 'corepack enable; corepack prepare pnpm@9 --activate; pnpm install --frozen-lockfile; timeout 90 pnpm -s vitest run <files>'` (run as root and, for permission tests, as a non-root user).

Authoring `earned_when`: the text says what a player does and may overlap the hidden fact in meaning; the Game Master sees only the condition, so the separation is lexical, not semantic. Do not paraphrase the fact more than necessary.

Live runs of the original scenario (US-0040, 2026-10-08, Gemma): `NPC_MODEL=... GM_MODEL=... pnpm -s demo --showcase --live --players generated --scenario scenarios/friday-escalation --gm-trace f.jsonl --transcript t.md --json r.json`; add `--player-model <id>` for a different (weaker) player model (nemotron-3-nano-omni-30b-a3b-jangtq4: 436 s, foundation: 185 s, the Game Master ended only 1 of 3 scenes), or omit `--players` for scripted live (121 s). Original scenario with Gemma players: 234 s, 2 of 3 scenes ended by the Game Master. The demo deletes its temp data (session log) at the end: copy the log while the run is going if you want excerpts. How to keep a live session log: the live showcase writes `$TMPDIR/acr-showcase-run-XXXX/data/demo.jsonl`; set `TMPDIR` to a known folder before the run and copy its `data/` while the run is active (the `acr-demo-*` directories left in the temp folder are a different demo mode, not these runs). Those logs feed `pnpm calibrate excerpt --log <demo.jsonl>`; the Friday set's 7 excerpts were cut from three such runs (Gemma, Nemotron-nano and foundation players, 2026-10-08). Scene 2 (Priya) ends by the facilitator advance in every live run, by design of the harness: after the last scripted line and a final evaluation, an open scene is advanced; the live Priya rarely agrees a concrete next step, and the only TRUE verdicts there are her earned_when checks, not the exit condition. `--max-false-exits` is still unusable for this scenario and `--max-lines 1` unsuitable.
