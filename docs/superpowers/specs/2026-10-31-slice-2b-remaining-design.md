# Slice 2b remaining work: live console (2b-2) and AI players (2b-3), refinements

Addendum to `2026-10-30-web-client-slice-2b-design.md` (sections 7 and 8). Where the two differ, this one wins. 2b-1 is built and merged.

## 1. Understanding

A facilitator runs a whole session from the browser, and an AI player can fill a role. Success: no terminal is needed, and no participant frame ever carries `by`, facilitator-only data or an unlabelled AI line. Owner decisions of 2026-10-31 are marked **[owner]**; the rest is my recommendation, agreed in conversation.

## 2. Order and stacks

Seven stacks, in order. Each gets its own plan, written when the one before it is merged.

| Stack | Content |
| --- | --- |
| 2b-2a | Runtime protocol: allowlisted player copies (own PR, first), `by`, talk time, `end_now`, `remove_participant` **[owner]** |
| 2b-2b1 | Facilitator SSE channel and read-only live view **[owner]** |
| 2b-2b2 | Command route, controls and confirmations |
| 2b-3a | AI-role state, start gate, marking, consent notice version |
| 2b-3b | Bot module, control-service host, Prompt AI player |
| 2b-3c | Group-score option, evaluator change, report labels (own independent review, AC-0326) |

## 3. Stack 2b-2a (runtime)

1. **Allowlisted copies first.** `viewFor` and `snapshotFor` become allowlisted: `by` is stripped from every command a player sees and a new state field reaches players only if listed. A test pins today's player snapshot so 2a players see no change. The leak scan covers `by`, `message` of `end_now` only where intended, and talk time.
2. **`by`.** Optional on `facilitator.command`, cleaned, at most 60 code points, attested by the BFF. Terminal facilitators send none.
3. **Talk time.** The spec's claim that the evaluator computes it is wrong: no formula exists (the method text only calls it "context, not a criterion"). Definition: words and lines per player role, folded from `utterance` events in the shared reducer in `packages/events`; a word is a whitespace-separated run of non-empty characters, Unicode-safe. NPC lines are counted apart as context. The console labels it "Words spoken", never "time". Facilitator snapshot only. **[owner: reducer]**
4. **`end_now { message? }`.** Facilitator client message, refused before the start and after the end, never triggers the auto-start. Inside the engine mutex: `scene.exited {reason: "facilitator_end"}` for the open scene, then `session.ended {reason: "facilitator_end", message?}`, then a facilitator-only alert naming who ended it. `ExitReason` gains `facilitator_end`; the reducer, restore fold, view policy and docs learn it. `message`: at most 300 characters, cleaned, shown to participants as text. The scene clock and Game Master stop. **[owner: scene.exited + session.ended]**
5. **`remove_participant { roleId }`.** Before the start only: revoke the credential, close the socket with a distinct code, clear consent, free the seat, then reissue the role's code in the same ordered step (AC-0314). Mid-session removal is out of scope; the facilitator ends the session instead.
6. **Tests.** Engine, fold and restore for each event; ws-server for each message including "never auto-starts"; an in-flight NPC reply or Game Master tick when `end_now` lands appends nothing after `session.ended`; the leak scan.

## 4. Stacks 2b-2b1 and 2b-2b2 (BFF and console)

- **B1.** One facilitator socket per console tab, forwarded as SSE with seq ids and `Last-Event-ID` replay by reusing `StreamHub` with a thin facilitator mode (not a fork). A route separate from the player stream, cookie checked on every connect and reconnect; a test that a player credential gets nothing from it. **First task: verify the runtime's connection caps** (32 total, 8 per address) against the fact that every stream reaches the runtime from the BFF's one address, and set the control service's caps explicitly. Live view: scene and timer, transcript with Game Master notices and alerts, words spoken. Polite live region, text-only rendering under the nonce CSP, Axe at laptop width.
- **B2.** `POST /api/v1/console/command` for pause, resume, advance, inject, whisper, release fact, NPC stance, `end_now`, `remove_participant`. `by` comes only from the sealed cookie; `expectSceneId` stays. Origin and `X-Requested-With`, strict JSON, neutral failures. Irreversible or audience-affecting actions use one confirmation naming subject and audience. A stale scene shows "the scene changed, review and retry" (acceptance criterion with a test).

## 5. Stacks 2b-3a, 3b, 3c

Design as in sections 8.1 to 8.5 of the parent spec, with these refinements:

- **Pacing defaults [owner: balanced]:** minimum gap 15 s, quiet-time nudge after 90 s, at most 10 lines per scene, 60 model calls per session (a bot line or a prompt). All are settings.
- **Never-hang rule:** every bot model call has its own hard timeout; a test proves a never-resolving provider leaves the control API responsive.
- **Reservation** for Prompt AI player is an in-memory map with a 10 s expiry in the control service; nothing persists.
- **Consent notice bump:** a test that a running session whose players consented under the old version is not locked out after a restart on the new version.
- **3c** ships last, after 3a and 3b are merged and stable.

## 6. Open items left for the plans

1. Exact connection caps (2b-2b1, first task).
2. `players/` subpath-export mechanism (2b-3b).
3. Where the lock-free log-tail check is exposed (parent spec item 3).
4. `fork()` under `tsx` is already answered by 2b-1 and drops off the list.
