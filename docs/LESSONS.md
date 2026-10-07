# Lessons

## L-0001 — PlanVisualizer installs are additive; install only from the released main

@agent: all

**Rule:** Install PlanVisualizer only from a fresh clone of the released `main` branch, never from a local `develop` checkout. `install.sh` copies files but never deletes them, so installing over a different-version install leaves orphaned tools and tests that fail against the new version. When reinstalling, restore your own `AGENTS.md`, `plan-visualizer.config.json` and docs afterwards; the installer replaces a missing `AGENTS.md` with a 7-line stub and resets the config project name.
_Learned when a develop-era install (repository layer needing `proper-lockfile` and `better-sqlite3`) was overwritten by `main` v2.4.0 and 47 test suites failed on 189 leftover files._
**Date:** 2026-10-01

## L-0002 — Tests must pass on Linux and must not depend on timing

@agent: all

**Rule:** CI runs Ubuntu. Never put `/proc`, macOS-only paths, `stat -f`, fixed sleeps, small real timers (`setTimeout(50)`), wall-clock windows or the shared `/tmp` in a test. Inject clocks, delays and hooks so tests control ORDER; give slow real-process tests an explicit generous timeout; run new filesystem, lock and process tests once in a `node:22` container (root and non-root) before pushing.
_Learned when a test using `/proc/nope/trace.jsonl` hung the whole Workspace Tests job for 20 minutes on Linux (creating a directory in procfs hangs) while it passed instantly on macOS, and a 50 ms re-check test failed only on a loaded runner._
**Date:** 2026-10-07

## L-0003 — Open once and fstat the descriptor: never check a path and then use it

@agent: all

**Rule:** Do not `stat`, `lstat` or `exists` a path and then open or read the same path. Open the file once (`O_EXCL` or `O_NOFOLLOW` where relevant), then take type, size, link count and mode from `fstat` on that descriptor. Tests too: read through one descriptor.
_Learned when CodeQL `js/file-system-race` (high) blocked pull requests six times on the demo audit, the Game Master trace writer, the report reader and their tests._
**Date:** 2026-10-07

## L-0004 — Never log an environment-derived string

@agent: all

**Rule:** Log constants, port numbers and booleans, never a value that came from an environment variable (bind host, paths, origins, tokens). Say 'bound to loopback only', not the address. Error messages for an invalid setting name the variable, not its value.
_Learned when CodeQL `js/clear-text-logging` (high) flagged the startup log line `runtime listening on ws://<host>` and an earlier `custom endpoint` log twice._
**Date:** 2026-10-07

## L-0005 — Pin the identity you compare: Linux reuses inode numbers at once

@agent: all

**Rule:** A lock or file identity check by device and inode is only sound while the file stays open. Hold the judged file descriptor open through the whole takeover so the inode cannot be recycled, and test the ORDER of a takeover race with injected hooks, not with timers.
_Learned when a stale-lock takeover closed the judged file first; on Linux the freed inode number was reused by the new holder's lock, the identity check matched a live lock and removed it, which could let two servers share one log. macOS did not show it._
**Date:** 2026-10-07

## L-0006 — Authenticate any model output that triggers an irreversible state change

@agent: all

**Rule:** The Game Master's `true` ends a scene, so a verdict must carry a per-evaluation secret nonce that exists only in the system prompt, and the parser must reject quoted, echoed, nested, duplicated, array, truncated and conflicting verdicts. 'Last JSON object wins' and a plain-text fallback are injectable by a participant typing `verdict: true`.
_Learned when an independent review reproduced five ways a tolerant parser returned a false `true` from participant text._
**Date:** 2026-10-07

## L-0007 — A write that fails part-way must fail-stop, not retry into divergent state

@agent: all

**Rule:** After any failure once writing has started (write, `fdatasync`, lock check) mark the log permanently broken, halt the engine, tell clients with an unlogged notice and exit non-zero for a supervisor. The log is the source of truth on restart. Check that every append path honours the flag, and that multi-append operations are completed on resume.
_Learned when a failed `fdatasync` left an event on disk that the engine never applied, and every later tick appended another `scene.exited` forever; a crash between two appends left a resumed session stuck with no scene._
**Date:** 2026-10-07

## L-0008 — Independent review with probes finds what tests and the author miss

@agent: all

**Rule:** Keep the build-then-review loop. Give the reviewer the diff, the requirement, and permission to run probes in a scratch copy. Re-review risky fixes (a fix introduced a CPU-amplification bug and a data-loss window). Exhaustive tests (cut a log at every event boundary) beat sampled ones.
_Learned when every Critical and Important finding on this project (forged verdicts, aborted re-ask, post-refusal frames, log divergence, crash windows) was reproduced by running code rather than found by reading._
**Date:** 2026-10-07

## L-0009 — Real model runs find what mock runs cannot

@agent: all

**Rule:** A green mock demo says nothing about prompt behaviour. After changing a prompt, parser or scenario script, run the live showcase on the real model and read the transcript.
_Learned when the private 'intent' text leaked after a `***` separator into every generated player line, characters spoke for each other, the CFO echoed the sponsor and replies were truncated by a too-small token budget: all invisible in mock mode and all found only in live transcripts._
**Date:** 2026-10-07

## L-0010 — Reserve id blocks for parallel work and keep generated files out of hand merges

@agent: all

**Rule:** When stories are built in parallel, reserve disjoint id blocks in the registry first, tell implementers not to edit the registry or `docs/plan-status.*`, and reconcile at merge; regenerate dashboards with `npm run plan:generate` instead of merging them. Also: parallel agents share `/tmp`, so tests that count temp directories flake.
_Learned when three parallel branches all appended to the same plan, registry and changelog sections; reserved blocks kept the ids unique and only text conflicts remained._
**Date:** 2026-10-07

## L-0011 — Never paste a secret into a chat or a repository file

@agent: all

**Rule:** Do not paste API keys into chat; put them in the git-ignored `.env` yourself. Redact secrets in any log written to the repository (the prompt log) and scan the output before committing. Rotate any key that was exposed and record the incident in `progress.md`.
_Learned when an OpenRouter key was pasted into a prompt on 2026-10-02; it stayed out of every committed file but must be rotated._
**Date:** 2026-10-07
