# Process and workflow

## Git
- `feature/*` (or `chore/*`) -> `develop` (PR) -> `main` (PR). Commit format `[type] ID: imperative description` (CLAUDE.md). Merge with merge commits. Do not rewrite pushed history: bring `develop` in with `git merge origin/develop`.
- Work in a worktree per story under `~/Projects/ai-coaching-rpg.worktrees/` (a `.env` must be copied in for live runs; it is git-ignored). Stacked PRs work: merge the base first, then bring `develop` into the next branch. Remove worktrees and merged branches afterwards.
- Merge a PR ONLY when the owner says so ("merge it", "merge when green"). Opening a PR, pushing a branch and watching CI do not need permission.
- Commit attribution trailer: the one the session's attribution reminder specifies (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`); PR bodies end with the Claude Code line.

## The build-and-review loop that worked
1. File the story in `docs/RELEASE_PLAN.md` with ACs and a TASK (format in `plan_visualizer.md`).
2. One implementer subagent per story in its worktree with a precise brief (sonnet for normal work, opus for large or delicate work such as resume and the lock). TDD, gates listed, no live model calls.
3. An independent opus reviewer on the diff, read-only, ending with `Assessment: ready to push`. Security-sensitive stories get probes: every Critical and Important finding of this project was reproduced by running code. Then a fix round, then a scoped re-review for risky changes.
4. The controller runs the real live checks (Gemma) and records them in the plan (AC annotations), then pushes, opens the PR, watches CI, merges when told.
Parallel stories: reserve id blocks up front (see below) and tell implementers not to edit `docs/ID_REGISTRY.md` or `docs/plan-status.*`; reconcile at merge.

## Plan files (PlanVisualizer v2.4.0; `plan_visualizer.md` is the format authority)
- Status values: epic `Planned|In Progress|Complete`; story `Planned|In Progress|Complete|Blocked` (NOT `Done`); task `To Do|In Progress|Done|Blocked`; bug `Open|In Progress|Fixed|Verified|Closed`.
- `npm run plan:generate` regenerates `docs/plan-status.*` (never hand-merge them); `npm run plan:test` includes a registry test: each Next/Last id in `docs/ID_REGISTRY.md` must equal the highest id used, and ids named in the registry's "Reserved blocks" line count as used.
- Current registry: next EPIC-0007, US-0035, TASK-0052, AC-0170, BUG-0006, L-0012 (see the file).

## Session close (AGENTS.md section 14)
Commit state, update `progress.md`, `MEMORY.md`, `PROMPT_LOG.md` (redact secrets: the repo is public), `docs/LESSONS.md`, `MIGRATION_LOG.md`, run coverage and log it, report to the owner. Never put a secret in any file in this repo; never print one in chat.

## Tool notes
- The Stop hook (`tools/capture-cost.js`) is run as `node "${CLAUDE_PROJECT_DIR:-.}/tools/capture-cost.js"` so it works from any directory; it appends to `docs/AI_COST_LOG.md`.
- In zsh a variable is not word-split: `for x in "a b"; set -- $x` does not split (a worktree was mis-created once). Use explicit arguments.
- `sleep N && ...` chains are blocked by the harness; use `until <condition>; do sleep 2; done` in a background command or a monitor.
- Parallel agents share `/tmp`: tests that count `acr-demo-*` temp dirs flake when several agents run demos at once (they pass in CI).
