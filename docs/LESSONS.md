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

## L-0012 — Never pass an async function where a synchronous check is expected

@agent: all

**Rule:** A guard or pre-commit hook typed `() => void` silently accepts an `async` function in TypeScript, so the check never runs and a rejection goes unhandled. Type such hooks as `() => undefined` (or reject a returned promise at run time and attach a catch), use the synchronous check (`lock.lost || !lock.verify()`) for file operations, and grep every use of an `async` function in a void-callback position.
_Learned when `lock.assertHeld()` (async) was used as a synchronous pre-rename check in the join-code file: the lock was never actually checked, a lost lock still committed or deleted the file, and the rejected promise would have crashed Node 22. Two review passes caught it only by running a probe._
**Date:** 2026-10-07

## L-0013 — Secrets shown once must survive a failed start

@agent: all

**Rule:** If a value is persisted before it is shown to the operator (join codes, tokens), every failure path between the write and the display must undo the write, and a start with nothing recorded yet must issue and show new values instead of silently keeping unseen ones. Test it: make the start fail, restart, and assert the value is shown.
_Learned when a port in use, a missing API key or a bad trace-file path left join codes on disk that nobody had seen, so the next start kept them silently and no player could join._
**Date:** 2026-10-07

## L-0014 — An abort must wait for the work it cancelled, and every resource is owned from the moment it exists

@agent: all

**Rule:** A timeout or abort that reports and returns without waiting for the work it cancelled leaks whatever that work creates next (temp directories, servers, files) and lets it keep running after the result is out. After aborting, wait for the work to unwind with a bounded grace, then clean up; hand each resource to the cleanup list the moment it exists (right after `mkdtemp`, not after it is filled) and have the code that makes it remove it if it is aborted half-way; check the abort signal after each await on the start-up path. Test abort paths deterministically: inject the timer and fire it by hand at the exact point (a hook between creation and registration), never with a small real timeout.
_Learned when the demo watchdog test failed intermittently under coverage (BUG-0007): the 100 ms watchdog fired while the run's temp directory was being made, `runDemo` returned, and the directory was registered and removed fire-and-forget later, or recreated by the run that was still going._
**Date:** 2026-10-07

## L-0015 — Review ground-truth data against the rubric, not only the schema

@agent: all

**Rule:** When data is the oracle (calibration probes, golden files, expected scores), have a reviewer judge each item against the rule that defines it (the rubric's own level anchors and its "choose the lower level when the higher anchor's key behaviour is missing" rule) and ask whether a careful rater could defend a different answer. A file that loads and validates can still carry a wrong label, and a wrong label silently biases every metric computed from it (bias, exact agreement, tuning).
_Learned when two starter probes labelled "level 4" for negotiation validated, passed every test and were level 3 by the rubric's anchor (no recommendation, no held condition, no stated-back next steps); only the content review caught it._
**Date:** 2026-10-07

## L-0016 — A quality label must require its headline measure, and a fix can create the next hole

@agent: all

**Rule:** If a label (PASS/WARN/FAIL) is supposed to certify a property, make the label impossible to earn without measuring that property: a rule that is silently skipped when its inputs are missing (no contrast probes, all answers unusable) turns "not measured" into "passed". After closing such a hole, re-test the neighbouring failure modes: the first fix made an outage read as a flat judge, and the second made a mid-run failure replace a good result. Give every rule a test for "no data", "partial data" and "all data bad".
_Learned when the calibration label let a judge that answered 3 to everything PASS (no contrast probes, or every contrast probe unusable), then labelled an outage as a flat judge, then let a judge that died mid-run replace a good summary file._
**Date:** 2026-10-07

## L-0017 — CodeQL scans test files, and a failed run must never overwrite the last good result

@agent: all

**Rule:** (1) In tests as well as production code, never check a path and then use it (`stat`/`lstat`/`access`/`exists` then `open`/`read`/`stat` of the same path): open once and read the mode and contents from that file handle; never assert HTML escaping with a regexp that filters tags: use substring checks. (2) A command that writes a "latest result" file that other tools read (a calibration summary the report stamp trusts) must replace it only after a complete, healthy run; a failed, aborted, partial or degraded run writes its own dated output and leaves the old file untouched.
_Learned when PR #36 failed the CodeQL check with three high alerts in a test file, and when review reproduced that an outage, a Ctrl-C, `--only` and a mid-run judge failure each replaced a good summary._
**Date:** 2026-10-07


## L-0018 — Verify that a captured artifact belongs to the run before you keep it

@agent: all

**Rule:** When you copy a log, transcript or result out of a temporary location, check that it is from the run you mean: timestamps inside it, the scenario id and version, the model names. Do not assume that the newest or only matching directory is yours. Name the location a tool really writes to (the live showcase writes `$TMPDIR/acr-showcase-run-XXXX/data/demo.jsonl`), set `TMPDIR` to a known folder for the run, and copy from there.
_Learned when a copy loop synced `acr-demo-*` directories (another demo mode) and saved a stale mock-story session log as if it were a live run's log; it was caught only by reading the timestamps and scenario version in it._
**Date:** 2026-10-08

## L-0019 — When practice has an exception, the rule text must name the exception and its record

@agent: all

**Rule:** If a written rule says "an agent never does X" and an agent does X on explicit owner instruction, change the rule the same day to say who may do it, under what instruction, and where the record lives (here: `approve` may be run by an agent only on the owner's explicit instruction naming the items, and the approval is recorded in `approved_by`, the commit history and the docs Limits section). Otherwise the docs describe something that is no longer true and the next reader cannot tell a sanctioned exception from a breach.
_Learned when the `approve` help and docs said an agent never approves probes while an agent approved 26 probes on the owner's chat instruction of 2026-10-08; the rule was reworded and the Limits section now lists the approval records._
**Date:** 2026-10-08

## L-0020 — A test double of a platform API must copy the platform's dispatch rules

@agent: all

**Rule:** When a fake stands in for a browser or runtime API (EventSource, WebSocket, fetch), make it behave as the specification does in the cases the code branches on, and write one test that pins each such rule on the fake itself. A fake that is simpler than the platform hides exactly the bugs that live in the difference. Where the real thing is cheap to run (a real runtime in mock mode, Chromium under Playwright), run the same scenario against it as well.
_Learned when the web client's fake EventSource never called `onerror` for a server-sent `event: error` frame, while browsers do: every jsdom test passed and the real page would have shown a Reconnecting banner that never cleared on a healthy stream. Only an independent review caught it (Task 14 of slice 2a)._
**Date:** 2026-10-28

## L-0021 — Find where a framework buffers a request body before trusting your own size cap

@agent: all

**Rule:** A size cap in a route handler protects nothing if a layer before it (middleware, a proxy, a body parser) has already read the whole body into memory. For every new HTTP entry point, check which layers see the body and their limits, keep middleware off routes that do not need it, set the framework's own body limit, and test with an oversized request against the built server, not only the handler.
_Learned when Next 16 copied up to 10 MB of every POST into memory for the request proxy (`src/proxy.ts`) before the BFF's 8 KiB cap ran; the fix excluded `/api` from the proxy matcher and set `proxyClientMaxBodySize`, and a 12 MB POST to the built app was then refused without buffering._
**Date:** 2026-10-28

## L-0022 — The order frames arrive at a client is not the order the server decided

@agent: all

**Rule:** When a server decides an order (which of two joins is newer) and several client connections observe it, never infer that order from when each connection's frames were read: TCP reads of different sockets interleave arbitrarily, and a frame and its connection's close can arrive in one read. Carry the server's order explicitly (a counter, a sequence number) or wait for the authoritative signal (the close code), and reproduce the interleaving in a test with a proxy that holds and releases bytes.
_Learned when two browser tabs joining one seat could both end "superseded": the stream hub treated "the connection I heard from last" as the newest, and a delayed tab whose `joined` and 4001 close arrived together replaced the live tab. A holding TCP proxy in `hub.runtime.test.ts` reproduced it; one narrow ordering remains documented in the threat model._
**Date:** 2026-10-28

## L-0023 — A wait for "a frame that matches" must start after the trigger

@agent: all

**Rule:** When a test waits for a message that a trigger should cause, take the position in the inbox (or a counter) just before the trigger and wait only for messages after it. A predicate that an earlier message already satisfies makes the test pass with the feature removed. Prove each such test by deleting the behaviour once and seeing it fail.
_Learned when the roster tests waited for a roster frame with `f.next()` that matched the roster sent at join, so removing the consent, leave or disconnect broadcast still passed (Task 8 of slice 2a); the fix took an offset before each trigger and every broadcast was then proven by mutation._
**Date:** 2026-10-28

## L-0024 — Let the page settle before an accessibility scan measures it

@agent: all

**Rule:** Before Axe (or any check that reads computed colours or layout) runs, wait for a settled page: the state you mean to test is reached (the message shown, the control enabled, not busy) and `document.getAnimations()` has nothing running or pending. A colour transition that starts when the colour scheme changes leaves a half-way background beside text that switched at once, so a contrast check passes or fails depending on timing. Reproduce such a failure by slowing the transition (or the animation playback rate) in a scratch build, never by waiting longer.
_Learned when the first two CI runs of the web Axe spec failed in different places: once a button's contrast on the refused join screen right after switching from dark to light (its 0.12 s background transition was mid-way), once a line that never reached the transcript; a 3 s transition in a scratch build made the first failure happen every time, and waiting for the animations to finish fixed it._
**Date:** 2026-10-28
