# EPIC-0002 Slice 2b-3a: AI-Role State, Start Gate, Marking and Log Format 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runtime can hold a set of player roles filled by an AI player before the start: it is set only by the control service over the private IPC channel, rotates the codes of the roles it changes, survives a lobby restart, gates the start (humans joined and consented, AI roles held by a connected bot with no consent), is frozen into `session.started` (log format 3), and reaches every player so no AI line is shown unlabelled; the consent notice says a seat may be an AI player (v2) without locking out a running session's v1 consents.

**Architecture:** One new IPC request `set_ai_roles { requestId, roles }` (runtime and control-service copies kept equal by the drift test), answered with the new codes of the changed roles. The state lives in a new seat file `<id>.ai-roles.json` until the start and in `session.started.aiRoles` from the start (the log wins on resume). `SessionState` folds `aiRoles` from `session.started`; the allowlisted player copies (`STARTED_FOR_PLAYERS` path, `PLAYER_SNAPSHOT`) and `PlayerView` carry it; roster entries carry `ai: true`. Nothing in 3a exposes the IPC to HTTP or the browser (Ruling A1), so no released build can hold an AI role without a bot to fill it.

**Tech Stack:** TypeScript, Node 22, zod (runtime and control only), ws, Next.js 16.4.1, React 19.3.0, vitest 5.0.3. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-31-slice-2b-remaining-design.md` section 2 (row 2b-3a and the 2b-3b start-gate sentence) and section 5 (binding; it wins over the parent), and `docs/superpowers/specs/2026-10-30-web-client-slice-2b-design.md` sections 8.1 to 8.5 and 11 ("Log format"). Story US-0060 (`docs/RELEASE_PLAN.md`, AC-0317 to AC-0322, umbrella TASK-0089). Predecessor: `docs/superpowers/plans/2026-11-01-slice-2b-2b2-facilitator-controls.md`. Security posture: `docs/THREAT_MODEL.md`.

## What exists today (verified against the code at f02d096)

- **Log format.** `LOG_FORMAT = 2` (`packages/events/src/events.ts:71`) is written into every `session.started` (`session-engine.ts:187`); restore refuses `logFormat > LOG_FORMAT` (`session-engine.ts:415`), so raising the constant is what makes an older runtime refuse a log. `session.started` has `roles, logFormat, scenarioHash, consents, names, logIdentity` (`events.ts:24-36`); no AI field exists anywhere in the repo. `SessionStartExtra` is `{ consents?, names?, logIdentity? }` (`session-engine.ts:64-68`). Tests that pin format 2: `packages/events/src/__tests__/state.test.ts:229`, `services/runtime/src/engine/__tests__/session-engine-restore.test.ts:148-160` and its "a newer log format (regression guard: 3 is refused ...)" at `:235`. The control service never reads the format: `readLogStatus` (`services/control/src/log-tail.ts:16`) only checks whether the last complete line is `session.ended`.
- **Start gate.** `SessionHost.startGate` (`session-host.ts:324-330`) requires every player role assigned and consented (`HostError("seats_not_ready", missing)`, message `seats_not_ready: a,b`) and returns `{ consents, names, logIdentity }`. The BFF start route parses that message (`apps/web/src/server/console-sessions.ts:429-437, 518-531`) and treats any code outside `START_ERRORS` (`:33-35`) as unreachable. A post-start join without the recorded consent throws `consent_required` (`session-host.ts:141`); an assignment exists only while the socket is open (`ws-server.ts:462-471` releases it on close), so "assigned" means "connected".
- **Seats.** `Seats = { credentials, consent, persist() }` (`engine/seats.ts:5`), built in `openSession.settleSeats` (`session-store.ts:185-221`), removed with the codes (`removeSeats`, `:156-161`), kept by a managed restart of an empty log (`:293-299`). Seat files are `secure-json-file.ts` records bound to `{ sessionId, scenarioSha256 }` (pattern: `consent-file.ts`). `ConsentStore` drops entries under another notice version on read (`consent.ts:35-38`); a resumed started session re-seeds them from the log without a version check (`session-host.ts:290-299`, R14), already pinned by `session-host-resume-consent.test.ts` "v1 -> v2 resume ..." and `reissue.restart.test.ts:66`.
- **Reissue.** `reissueRole` (`host/reissue.ts:53-89`) is the write-first order: new codes file, then revoke and persist, then kick (`CLOSE_REISSUED` 4002, `CLOSE_REMOVED` 4003, `ws-server.ts:20-22`) and swap; nothing is appended before the start. `ServerHandle` has `replaceCodes` and `kickRole` only (`ws-server.ts:66-76`). A code opens any role without a credential (`ws-server.ts:330-332`), so revoking a credential alone reopens the seat to whoever still holds the old code.
- **IPC.** Runtime `ParentMessageSchema` is ONE strict object (`type: "reissue"`, `host/parent-channel.ts:20-27`); `ChildMessageSchema` is `codes, ready, ended, reissued, reissue_failed` (`:30-39`). The control service keeps its own copy (`services/control/src/protocol.ts:16-35`), compared by `protocol.drift.test.ts`. `main.ts:239-257` answers every parent message as a reissue. `Supervisor.reissue` (`supervisor.ts:404-432`) is the pending-request pattern (requestId, `withLock`, timeout, `onChildExit` rejects). `api.ts` has no AI route.
- **Player copies.** `PLAYER_SNAPSHOT` lists every `SessionState` key (`host/player-copies.ts:21-38`; a new key is a compile error); `STARTED_FOR_PLAYERS` likewise for `session.started` (`:50-52`), with `roles` reduced to kinds and only the player's own consent (`:54-62`). The pin "pins today's player snapshot (2a sees no change)" is `player-copies.test.ts:49`. The console's `CONSOLE_STATE` is the web twin (`apps/web/src/server/facilitator-copies.ts:16-33`, also compile-checked) and `EVENT_COPY["session.started"]` picks fields (`:51-56`).
- **Player view and page.** `PlayerView` has no roles field (`packages/events/src/player-view.ts:14-24`); `applyPlayerEvent` sets only `status` on `session.started` (`:48-49`). The player BFF forwards runtime events and roster entries verbatim (`stream-hub.ts:184-192`); `use-session.ts:129-131` checks roster entries but keeps extra keys. `Transcript.tsx:33` labels a line AI only when its role is NOT a roster seat, so an AI player's line would be unlabelled. A refused display name from the runtime becomes the generic `badName` copy (`handlers.ts:207`).
- **Names.** `normalizeDisplayName` (`host/display-name.ts:13-21`) has no reserved words; the credential name is `name ?? roleId` (`ws-server.ts:349`). Player roles have no title in the scenario schema (`packages/script/src/schema.ts:24`); the web's `roleLabel` derives one from the id (`apps/web/src/lib/names.ts`).
- **Consent notice.** Default `v1` (`services/runtime/src/main.ts:110`); `consent/notice-v1.md` (sha256 `7dde9e1e98d74b1f7b5943f96e6b808aad074d154e50b8224ee66d6f026b2b09`) already says "some of the other characters in the scene may be played by an AI", i.e. AI characters, not seats. `docs/THREAT_MODEL.md` "Consent notice versions" says a change in "which roles may be AI" needs a new version. Bootstrap-based tests that send `noticeVersion: "v1"` against the default include `apps/web/src/server/__tests__/hub.runtime.test.ts:399` and `services/runtime/src/__tests__/main.parent.test.ts:86`.
- **Out of scope but present.** The player bot is `services/runtime/src/demo/player-bot.ts` (moves in 2b-3b). The evaluator scores every player role (`evaluator/evaluate.ts:101`) and self-assessment is `self.rated` in `review/` (2b-3c). Report-access credentials do not exist yet (US-0062, slice 2c).

## Global Constraints

- **Scope (3a delivers / prepares / leaves).** Delivers: AC-0320 in full on the runtime (aiRoles recorded, AI seats skip consent, the gate counts human seats and connected bots separately); the runtime half of AC-0317 (fixed after the start) and AC-0318 (revoke credential and consent, rotate the code, close the human's socket); the player-page half of AC-0321 (transcript and roster labels, reserved prefix). Prepares: AC-0322 (the log fold's `state.aiRoles` is what 2b-3c's evaluator and self-assessment and 2c's report access read); the console label of AC-0321 (`aiRoles` reaches the console state and `session.started` copy, no UI). Leaves to 2b-3b: AC-0319, the control HTTP route, BFF route and toggle UI with its confirmation (AC-0317, AC-0318), stopping the bot and showing the new code once, the console, the bot intent log and its leak scan; to 2b-3c: the group-score option (`includeInGroup`), AC-0322 and AC-0323 to AC-0326; to 2c: report-access credentials and exports.
- **IPC (both copies identical).** Parent: `{ type: "set_ai_roles", requestId, roles: RoleId[] }` (strict, `.max(MAX_CODES)` = 256; no `by`, no `includeInGroup`). Child: `{ type: "ai_roles_set", requestId, codes: { roleId, code }[] }` (`.max(MAX_CODES)`), `{ type: "ai_roles_failed", requestId, reason }` (`.max(MAX_REASON_CHARS)` = 200), and `ready` gains `aiRoles?: RoleId[]` (`.max(MAX_CODES)`, present only when non-empty). `ParentMessageSchema` becomes `z.discriminatedUnion("type", [reissue, set_ai_roles])`.
- **Fixed reasons** (`host/ai-roles.ts` `AI_ROLES_REFUSED`): `started` "AI roles can only be changed before the start" (also while starting and after the end); `invalid` "not a player role of this session" (unknown, AI character, reserved, duplicate); `noHuman` "at least one player role must stay human"; `failed` "the AI roles could not be changed" (write failure, no seats, anything else). Never a path, a role list or an Error message.
- **set_ai_roles order** (mirrors `reissueRole`): refusals first, nothing changed; `changed` = symmetric difference in `playerRoleIds()` order; empty `changed` returns `[]` and writes nothing; new codes for every changed role written FIRST; then revoke each changed role's credential, withdraw its consent, replace the AI set, persist (credentials, consent, AI-role file, in that order); a failure restores all three in memory, writes the old codes back and rethrows; then kick each changed role (to AI: `CLOSE_AI_FILLED = 4004` reason `"ai_filled"`; back to human: `CLOSE_REISSUED` 4002) and swap the codes; then `broadcastRoster`. Nothing is appended to the log.
- **AI-role file.** `<id>.ai-roles.json`, mode 0600 via `writeSecureJson`, `MAX_AI_ROLES_FILE_BYTES = 16 * 1024`, record `{ v: 1, sessionId, scenarioSha256, roles }` (`AI_ROLES_RECORD_VERSION = 1`; roles distinct player role ids of the bind, scenario order). Read only beside credentials that match the bind; removed and swept with the other seat files; absent means no AI roles. From the start it is ignored: `engine.state.aiRoles` (from the log) is the record.
- **Log format.** `LOG_FORMAT = 3` (newest read and written), `LOG_FORMAT_WITHOUT_AI_ROLES = 2`, `logFormatFor(aiRoles: readonly string[]): number` (3 when non-empty, else 2). `session.started.aiRoles` only when non-empty, scenario order. Restore: formats 0 to 3; `aiRoles` with format below 3, a non-array, a non-string, a duplicate, an AI character or an unknown role is `RestoreError("invalid_log")`; format 3 without `aiRoles` is accepted. Engine start refuses bad `extra.aiRoles` with `EngineError("bad_ai_roles")`.
- **Gate.** Humans (player roles not AI): assigned and consented. AI roles: assigned (a bot is connected); no consent. Refusal stays `seats_not_ready: <humans not ready, playerRoleIds order>,<AI roles without a bot, same order>` so the BFF start route is unchanged.
- **Marking.** `AI_PLAYER_NAME = "AI player"`; an AI seat's credential name is always `AI_PLAYER_NAME` (any `displayName` the join sent is ignored for it). `isReservedDisplayName(name)` is true when `name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()` starts with `"ai player"`; such a join is refused before authentication (runtime `bad_message` "displayName: names starting with \"AI player\" are reserved"; BFF 400 `reserved_name` "Names starting with “AI player” are kept for AI players. Choose another name."). Roster entries of AI seats carry `ai: true` (absent otherwise), facilitator `consented: false`, peers `ready: joined`. An AI seat's `joined` has no `consent` field; `consent` and `withdraw_consent` from it are `forbidden` "an AI player gives no consent" (`leave` still works). Labels come from `aiRoles` (state, view, roster flag), never from a name.
- **Player page copy.** AI player line: name "AI player", pill "AI", muted role label. Roster AI seat: "AI player", muted role label, "Ready" / "Not joined". Final `ai_filled`: title "Role filled by an AI player", text "The facilitator has filled this role." (`MESSAGES.aiFilled` equals `AI_FILLED_MESSAGE` in `stream-hub.ts`).
- **Consent notice v2** (`consent/notice-v2.md`, default `CONSENT_NOTICE_VERSION=v2`): notice-v1.md with its "AI roles:" paragraph replaced by "AI roles: some of the other characters in the scene, and some of the other participants' seats, may be played by an AI, not by a person. A seat played by an AI is always named “AI player” and its lines are marked AI. Their lines are generated by a computer model and may be wrong or surprising. To produce them, the conversation may be sent to an AI model service." (owner approval: Open question 1). `notice-v1.md` stays byte-identical.
- **Tests** run on the `friday-escalation` scenario where two roles are needed (players `account_manager`, `delivery_lead`, `tech_lead`; AI character `client_sponsor`; scene 1 participants `delivery_lead, tech_lead, account_manager`); `tech_lead` is the AI seat unless a test says otherwise. Injected timers, `vi.waitFor` on effects, no elapsed-time assertions.
- Commit format `[TYPE] US-0060: description` (max 72 chars), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Before every commit: `pnpm -r --if-present typecheck` and the touched packages' `pnpm --filter <pkg> exec vitest run <files>`. Every new filesystem, socket or process test passes the node:22 container recipe (`AGENTS.md` section 8, "Linux"; root and `--user node`) AFTER its commit, with repo-relative paths. Squash merges into `develop`. Ids are assigned by each PR's docs task (next free then; expected values noted); each PR adds its user-visible change under `[Unreleased]` in `CHANGELOG.md`.

## Rulings

- **A1 The start gate ships in 3a, unreachable.** Ruling: the runtime gate, IPC and `Supervisor.setAiRoles` ship, but no HTTP or BFF route calls them until 2b-3b ships the bot host and the toggle together (a 3a test pins that the control API has no AI route) since a route without a bot would let a facilitator make a session that can never start, the spec's own failure case; costs, if wrong: dead-but-tested code in a released build, and 3b adds the route rather than a hidden test path.
- **A2 Rotate codes inside `set_ai_roles`.** Ruling: every role whose AI flag changes gets a new code in the same step, written first, since a revoked credential reopens the seat to its old code (a switched-out human could walk into the AI seat unconsented, and the bot's code would reopen a seat handed back to a human); costs: the reply carries codes, and 3b must keep an AI role's code out of the BFF.
- **A3 A separate seat file, not a credentials field.** Ruling: `<id>.ai-roles.json` beside the credentials and consent files, persisted last, since adding a field to the credentials record would need a record-version bump and a crash between files must leave a role "human without credential" (unusable until reissued) rather than "AI with a human's credential"; costs: one more file to sweep, remove and document.
- **A4 Format 3 only when AI roles are recorded.** Ruling: `logFormatFor` writes 3 only with `aiRoles`, and `aiRoles` in a format-2 log is refused, since the spec keeps other sessions on format 2 (a rollback can still resume them) and a format-2 log with AI roles would be resumed as human by an older build; costs: two format constants instead of one.
- **A5 Additive wire shapes.** Ruling: `aiRoles` on `session.started` and roster `ai: true` appear only when non-empty or true, while `SessionState.aiRoles` is always present (the player snapshot pin gains `aiRoles: []`), since 2a frames for sessions without AI roles stay byte-identical and a state field needs a value; costs: readers must treat absence as "none".
- **A6 One gate code.** Ruling: the refusal stays `seats_not_ready` naming humans first, then AI roles without a bot, since the BFF start route parses that message today; the console tells the two apart with the roster's `ai` flag in 3b; costs: a 3a console shows an AI seat as "not consented" until 3b.
- **A7 Labels from `aiRoles`, names reserved.** Ruling: the AI seat's name is fixed to "AI player" and humans cannot take the prefix (NFKC, case and whitespace folded), but every label is derived from `aiRoles`, never from a name, since a name is typed text; costs: names such as "AI-player" stay allowed (they get no pill).
- **A8 4004 and its screen in 3a.** Ruling: the runtime's `CLOSE_AI_FILLED` and the BFF and page handling of it land in 3a since the runtime defines the code here and an unknown close would show "Reconnecting" forever; costs: a screen no 3a flow reaches (unit-tested only).
- **A9 Notice v2 is the default in 3a.** Ruling: v2 ships with the IPC, since the notice must say seats may be AI before any build can fill one, and lobbies at the upgrade simply consent again (their v1 entries are dropped; started sessions keep the log's); costs: participants in a lobby during the upgrade click "I agree" again.
- **A10 AC-0322 is not built in 3a.** Ruling: 3a only records `aiRoles` in the log fold; excluding AI roles from scoring and self-assessment is the evaluator change of 2b-3c (AC-0326 review) and report access is 2c, since splitting the evaluator change across stacks would bypass its independent review; costs: until 2b-3c an AI seat's draft report would exist if someone ran the evaluator on a format-3 log.
- **A11 Idempotent request without `by`.** Ruling: the same set again answers `[]` and writes nothing, and the request carries no `by`, since nothing may be appended before the start; costs: 3b must reissue the changed roles itself after a timed-out `set_ai_roles` (it cannot learn the codes from a retry).
- **A12 `ready.aiRoles` and `Supervisor.aiRolesOf`.** Ruling: the runtime reports its AI roles on `ready` and the supervisor keeps them in memory, since after a control-service restart 3b must know which roles need a bot; costs: one optional field in the drift-checked IPC.

## Review Focus

1. **A human in an AI seat.** After a switch, the human's old code, their credential and a reconnect token of their old socket are all refused for that seat, and the bot's old code is refused after a switch back (Task 7: "after the switch, account_manager's old join code and Pat's credential are both refused"; Task 14 end to end).
2. **Restart and resume of the new state.** A managed lobby restart keeps the AI set with its codes; reissued codes remove it with the seats; a started session takes `aiRoles` from its log even when the file is gone or says otherwise; a bot rejoins a started AI seat without consent; a format-2 log resumes unchanged (Tasks 2, 3, 8, 11).
3. **Log format bump.** Old logs (formats 0 to 2) still load; format 4 is refused; `aiRoles` in a format-2 log or naming `client_sponsor` is refused; a session without AI roles still writes format 2 so a rollback can resume it (Task 2).
4. **AI data crossing to players.** Players get `aiRoles` and the `ai` flag only through the allowlisted copies, as fresh arrays, and never the bot's participant id, credential, code, `names` or a consents entry; the BFF picks peer roster fields instead of forwarding them; no AI line renders without its label, even when a stale roster name says otherwise (Tasks 1, 6, 12, 13, 14).
5. **Malformed or racing IPC.** Extra keys, 257 roles, reserved ids, duplicates, all roles AI, a request while the start is in flight, a late reply, a reply from an old child and a child exit all leave the state unchanged and answer with a fixed reason (Tasks 7, 8, 9).

## File Structure

| File | Responsibility |
|---|---|
| `packages/events/src/{events,state,player-view,ids,index}.ts` | `aiRoles` on `session.started`, `SessionState`, `PlayerView`; format constants; `AI_PLAYER_NAME`, `isReservedDisplayName` |
| `services/runtime/src/engine/{session-engine,ai-roles,ai-roles-file,seats,session-store}.ts` | Start writes and restore reads format 3; the AI-role seat file |
| `services/runtime/src/host/{session-host,ws-server,roster,player-copies,ai-roles,parent-channel}.ts`, `src/main.ts` | Gate, AI joins, marking, `setAiRoles`, IPC dispatch, `ready.aiRoles` |
| `services/control/src/{protocol,supervisor}.ts` | Protocol copy; `setAiRoles`, `aiRolesOf` (no HTTP route) |
| `consent/notice-v2.md` (new) | The notice with AI seats |
| `apps/web/src/server/{facilitator-copies,handlers,runtime-connection,stream-hub,wire}.ts` | Console copies of `aiRoles`; reserved name; 4004; peer roster pick |
| `apps/web/src/lib/{use-session,messages}.ts`, `components/{Transcript,Roster,SessionScreen}.tsx` | Player page labels and the `ai_filled` final |

---

## PR 1: the AI-role record and log format 3 (`feature/EPIC-0002-US-0060-ai-role-record`, from `develop`)

### Task 1: `aiRoles` in events, state, player view and the allowlisted copies

**Files:** Modify `packages/events/src/{events,state,player-view,ids,index}.ts`, `services/runtime/src/host/player-copies.ts`, `apps/web/src/server/facilitator-copies.ts`; Test `packages/events/src/__tests__/{state,player-view,ids}.test.ts`, `services/runtime/src/host/__tests__/player-copies.test.ts`, `apps/web/src/server/__tests__/facilitator-copies.test.ts`.

**Interfaces:**
- `session.started` gains `aiRoles?: string[]` (the format constants change in Task 2, so this commit still writes and reads format 2); `AI_PLAYER_NAME = "AI player"`; `isReservedDisplayName(name: string): boolean` (Global Constraints).
- `SessionState.aiRoles: string[]` (`[]` initially; `reduce` on `session.started` keeps string entries naming a `kind: "player"` role of `e.roles`, first occurrence only). `PlayerView.aiRoles: string[]` (`initPlayerView`: snapshot's strings or `[]`; `applyPlayerEvent` on `session.started`: the event's strings or `[]`).
- `PLAYER_SNAPSHOT.aiRoles: (s) => [...s.aiRoles]`; `STARTED_FOR_PLAYERS` excludes `aiRoles` and `startedForPlayer` adds a new array of its strings only when non-empty. `CONSOLE_STATE.aiRoles: (s) => strings(s.aiRoles)`; `EVENT_COPY["session.started"]` adds `aiRoles` (strings) only when non-empty.

- [ ] **Step 1: Write the failing tests:** `session.started with aiRoles ["tech_lead", 7, "client_sponsor", "tech_lead"] folds to ["tech_lead"] when client_sponsor is an npc; without the field aiRoles is []`; `reduceReplay agrees with reduce on aiRoles`; `"AI player", "ai  PLAYER Bob", " AI player", "ＡＩ player" are reserved; "Aiden Player", "AI-player", "Player AI" and "A.I. player" are not`; `initPlayerView takes aiRoles from the snapshot and [] when absent`; `applyPlayerEvent sets aiRoles from session.started and a duplicate seq changes nothing`; player-copies: the pin "pins today's player snapshot" gains `aiRoles: []` (the only change), `a player snapshot of a session started with tech_lead as AI lists ["tech_lead"]`, `a player's session.started carries aiRoles equal to but not the same array as the event's, and a poison key aiSecret never`, `a session.started without aiRoles reaches a player without the key`; console: `consoleState carries aiRoles and consoleEvent copies them only when non-empty, dropping non-strings`.
- [ ] **Step 2:** Run `pnpm --filter @acr/events exec vitest run`, `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/player-copies.test.ts`, `pnpm --filter @acr/web exec vitest run src/server/__tests__/facilitator-copies.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with typecheck; expect PASS. Mutations the tests must catch: listing `aiRoles` in `STARTED_FOR_PLAYERS` (same array reaches players), `PLAYER_SNAPSHOT.aiRoles: () => []`, dropping the npc filter in `reduce`.
- [ ] **Step 5:** Commit `[feat] US-0060: aiRoles in session.started, state and player copies`.

### Task 2: The engine writes and restores log format 3

**Files:** Modify `packages/events/src/events.ts` (format constants), `services/runtime/src/engine/session-engine.ts` (`SessionStartExtra`, `doStart`, `doRestore`, `ResumeInfo`); Test `packages/events/src/__tests__/state.test.ts`, `services/runtime/src/engine/__tests__/session-engine-restore.test.ts`, `session-engine.test.ts`.

**Interfaces:** `LOG_FORMAT = 3`, `LOG_FORMAT_WITHOUT_AI_ROLES = 2`, `logFormatFor(aiRoles: readonly string[]): number` (Global Constraints); `SessionStartExtra.aiRoles?: string[]`; `doStart` refuses (`EngineError("bad_ai_roles")`, nothing appended) a duplicate, non-player or unknown id, writes `aiRoles` in `Object.keys(scenario.roles)` order only when non-empty and `logFormat: logFormatFor(aiRoles)`. `ResumeInfo.startedAiRoles?: string[]` (present only when non-empty). Restore rules per Global Constraints.

- [ ] **Step 1: Write the failing tests:** `LOG_FORMAT is 3, logFormatFor([]) is 2 and logFormatFor(["tech_lead"]) is 3` (replaces `expect(LOG_FORMAT).toBe(2)` at `state.test.ts:229`); `a start without AI roles writes logFormat 2 and no aiRoles key` (the existing `:148-160` expectations become literal 2); `a start with aiRoles ["tech_lead"] writes logFormat 3 and aiRoles ["tech_lead"]`; `aiRoles ["tech_lead", "delivery_lead"] are written in scenario role order`; `aiRoles naming client_sponsor, "ghost" or tech_lead twice is bad_ai_roles and the log stays empty`; `a format 3 log with aiRoles ["tech_lead"] resumes with state.aiRoles and info.startedAiRoles ["tech_lead"]`; `a format 2 log written before this change resumes with aiRoles [], no startedAiRoles, and its first line still says logFormat 2 after markResumed`; `a newer log format: 4 is refused` (replaces the `:235` case for 3); `aiRoles in a format 2 log is invalid_log and nothing is appended`; `aiRoles naming client_sponsor, an unknown role, a number or a duplicate is invalid_log`; `a format 3 log without aiRoles resumes with none`.
- [ ] **Step 2:** Run the three files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, the events and runtime engine suites and typecheck; expect PASS. Mutations: writing `LOG_FORMAT` unconditionally; dropping the "format below 3" guard; accepting an npc id.
- [ ] **Step 5:** Commit `[feat] US-0060: log format 3 records the AI roles at the start`.

### Task 3: The AI-role seat file

**Files:** Create `services/runtime/src/engine/ai-roles.ts`, `engine/ai-roles-file.ts`; Modify `engine/seats.ts`, `engine/session-store.ts` (`readSeats`, `settleSeats`, `removeSeats`, the temp sweep, `persist`, `discardIssuedCodes`); Test `engine/__tests__/ai-roles.test.ts` (new), `engine/__tests__/session-store.ai-roles.test.ts` (new; harness of `session-store.managed.test.ts`).

**Interfaces:** `AI_ROLES_RECORD_VERSION = 1`; `type AiRolesRecord = { v: 1; sessionId: string; scenarioSha256: string; roles: string[] }`; `class AiRolesRecordError extends Error`; `class AiRoleSet { static empty(): AiRoleSet; static fromRecord(raw: unknown, bind: Bind & { roleIds: string[] }): AiRoleSet; has(roleId: string): boolean; list(): string[]; replace(roles: string[]): void; toRecord(bind: Bind): AiRolesRecord }`; `aiRolesFileName(sessionId)`, `MAX_AI_ROLES_FILE_BYTES`, `readAiRolesFile(dir, bind): AiRoleSet | null`, `writeAiRolesFile(dir, bind, set, beforeCommit?)`, `removeAiRolesFile(dir, sessionId)`, `sweepAiRolesTemps(dir, sessionId)`. `Seats.aiRoles?: AiRoleSet` (optional, so the many test literals of `Seats` stay valid; absent means none; `openSession` always sets it). `persist()` writes credentials, consent, then the AI-role file. The AI-role file is removed before new credentials are written (like the consent file, `session-store.ts:206-210`).

- [ ] **Step 1: Write the failing tests:** `fromRecord refuses another session, another scenario hash, v 2, an extra key, a role outside the bind, a duplicate and a non-array, and no message contains the value "SECRET-ROLE-X"`; `toRecord then fromRecord keeps the roles in bind order`; store: `a managed restart of an empty log keeps {tech_lead} with the kept codes and seats`; `codes that no longer fit remove the AI-role file with the seats: the reopened set is empty`; `SESSION_START=fresh and the rotation of an ended log remove the file`; `a lobby from before this change (no AI-role file beside kept credentials) has no AI roles and the file is written`; `when writing the AI-role file fails (a directory in its place), the credentials and consent files already hold the change and persist throws`; `the file is mode 0600 and a symbolic link in its place is refused unread`; `a stale <id>.ai-roles.json.<hex>.tmp is swept on open`; `discardIssuedCodes removes an AI-role file this start created`.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `session-store*.test.ts` and typecheck; expect PASS. Mutations: keeping the file when codes are reissued; writing it before the credentials.
- [ ] **Step 5:** Commit `[feat] US-0060: keep the lobby's AI roles beside the seat files`; then both new files in the node:22 container (root and `--user node`); expect PASS.

### Task 4: PR 1 docs and pull request

**Files:** Modify `docs/ROLLBACK.md` (new slice 2b-3a section), `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md` ("Logs at rest" and "The player credential and the seat files"), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** ROLLBACK: the runtime reads formats 0 to 3 and writes 3 only for a session with AI roles; a build before this slice refuses a format-3 log (`log_format`); no 3a build can produce one (A1), so rolling back from 3a is unaffected, and rolling back from 2b-3b to 3a resumes format-3 logs. THREAT_MODEL and ARCHITECTURE: the new file, the log as the record from the start. CHANGELOG "Changed".
- [ ] **Step 2:** Assign the next free ids (expected AC-0358, TC-0100, TASK-0098). `AC-0358: session.started records aiRoles in scenario order (log format 3) only when a session has AI roles, other sessions keep format 2, the runtime reads formats 0 to 3 and refuses aiRoles in an older format, and the lobby's AI roles are kept in <id>.ai-roles.json beside the seat files across a managed restart` (checked, TC-0100 naming Tasks 1 to 3 files). `TASK-0098 (US-0060): AI-role state, start gate, marking, consent notice v2 and log format 3 (slice 2b-3a)`, In Progress, Branch `feature/EPIC-0002-US-0060-ai-role-record` (PR 2 `feature/EPIC-0002-US-0060-ai-role-gate`, PR 3 `feature/EPIC-0002-US-0060-ai-role-labels`), Notes naming this plan; US-0060 In Progress.
- [ ] **Step 3:** `npm run plan:generate` (no parse errors); commit `[docs] US-0060: record log format 3 and the AI-role file`.
- [ ] **Step 4:** Push, open PR 1 into `develop` (body: US-0060, AC-0358, TASK-0098). Wait for the squash merge before PR 2.

---

## PR 2: gate, marking and the `set_ai_roles` IPC (`feature/EPIC-0002-US-0060-ai-role-gate`, from `develop` after PR 1)

### Task 5: The start gate and AI seats in the host

**Files:** Modify `services/runtime/src/host/session-host.ts` (`isAiRole`, `aiRoleIds`, `join`, `startGate`), `host/ws-server.ts` (reserved name, credential name, `joined.consent`, `consent`/`withdraw_consent`); Test `services/runtime/src/host/__tests__/ws-server.ai-roles.test.ts` (new; harness of `ws-server.consent.test.ts` on `friday-escalation`, `Seats` with `aiRoles: AiRoleSet` holding `tech_lead`).

**Interfaces:** `SessionHost.isAiRole(roleId: string): boolean` (`engine.state.status === "idle"` ? `seats?.aiRoles?.has(roleId) ?? false` : `engine.state.aiRoles.includes(roleId)`); `SessionHost.aiRoleIds(): string[]` (`playerRoleIds()` order). `join` skips both consent checks (the pre-start rebind clean-up and `consent_required`) for an AI role. `startGate` per Global Constraints and returns `aiRoles` (only when non-empty) in `SessionStartExtra`.

- [ ] **Step 1: Write the failing tests:** `with nobody seated start is refused "seats_not_ready: account_manager,delivery_lead,tech_lead"`; `with both humans consented and no bot the refusal names only tech_lead`; `with the bot joined (no consent) start succeeds: session.started has aiRoles ["tech_lead"], logFormat 3 and no consents entry for tech_lead`; `a session without AI roles: the refusal, joined frames and session.started are as before (logFormat 2, no aiRoles key)`; `the bot's credential is named "AI player" whether its join sent no displayName or "Bob"`; `joined for tech_lead has no consent field; consent and withdraw_consent from it are forbidden and the consent store is unchanged; leave still frees the seat`; `after the start a new bot participant rejoins tech_lead with a reissued code and is not refused consent_required, while a different participant for account_manager still is`; `a human join named "ai Player Pat" or "ＡＩ player" is bad_message before authentication: the throttle is not charged and a join named "Pat" with the same code succeeds next`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `ws-server.consent.test.ts`, `ws-server.credentials.test.ts`, `session-host*.test.ts`, typecheck; expect PASS. Mutations: treating an AI role as human in the gate (bot-only start fails); skipping the human check when an AI role is present; checking the reserved prefix after authentication.
- [ ] **Step 5:** Commit `[feat] US-0060: the start gate counts humans and AI bots apart`; then the file in the node:22 container (root and `--user node`).

### Task 6: Roster flag and labelled AI lines for players

**Files:** Modify `services/runtime/src/host/roster.ts`, `host/ws-server.ts` (`broadcastRoster`); Test `host/__tests__/roster.test.ts`, `ws-server.ai-roles.test.ts`.

**Interfaces:** `FacilitatorRosterEntry` and `PeerRosterEntry` gain `ai?: true`; `buildRoster(input: { ...; aiRoles?: ReadonlySet<string> })`: an AI seat is `{ ..., consented: false, ai: true }` for the facilitator and `{ roleId, name?, ready: joined, ai: true }` for peers; human entries unchanged (no `ai` key, so `ws-server.roster.test.ts:74` stays as it is). `broadcastRoster` passes `new Set(h.aiRoleIds?.() ?? [])`.

- [ ] **Step 1: Write the failing tests:** `an AI seat is listed with ai true and consented false, and ready for peers once its bot holds it; human entries have no ai key`; `the peers roster before the start shows tech_lead as ai and ready after the bot joined`; `a player frame labels an AI line: account_manager's session.started copy lists aiRoles ["tech_lead"], the bot's line in scene 1 reaches account_manager with roleId tech_lead, and account_manager rejoining afterwards gets aiRoles ["tech_lead"] in its snapshot` (AC-0321); `no frame a player receives carries the bot's participant id "BOT-PID-7", its credential, its join code, the names table or a consents entry for tech_lead` (each marker first found on the facilitator socket or in the join reply, so the scan can fail).
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `ws-server.roster.test.ts`, `roster.prompt-leak.test.ts`; expect PASS. Mutations: `ready` for an AI seat requiring consent; copying `participantId` into the player's `roles`.
- [ ] **Step 5:** Commit `[feat] US-0060: players see which seats and lines are AI players`.

### Task 7: The `setAiRoles` operation

**Files:** Create `services/runtime/src/host/ai-roles.ts`; Modify `host/ws-server.ts` (`CLOSE_AI_FILLED`, `ServerHandle.broadcastRoster`, the kick reason text); Test `host/__tests__/ai-roles.set.test.ts` (new; fakes as `reissue.test.ts`), `host/__tests__/ai-roles.socket.test.ts` (new; real sockets as `reissue.remove.test.ts`).

**Interfaces:** `export const CLOSE_AI_FILLED = 4004` (close reason `"ai_filled"`); `ServerHandle.broadcastRoster(sessionId: string): void`; `AI_ROLES_REFUSED` (Global Constraints); `class AiRolesRefusedError extends Error { readonly reason: string }`; `type AiRolesDeps = Omit<ReissueDeps, "server"> & { server: Pick<ServerHandle, "kickRole" | "broadcastRoster"> }`; `setAiRoles(d: AiRolesDeps, roles: string[]): Promise<{ roleId: string; code: string }[]>` (order per Global Constraints; codes in `playerRoleIds()` order; requires `d.seats.aiRoles`, else `failed`).

- [ ] **Step 1: Write the failing tests:** `switching account_manager (joined and consented as Pat) to AI writes a new code first, revokes the credential, withdraws consent, closes the socket with 4004 "ai_filled" and returns one code for account_manager`; `after the switch, account_manager's old join code and Pat's credential are both refused` (sockets); `switching tech_lead back to human closes the bot with 4002, revokes the bot's credential and returns a new code; the bot's old code is refused`; `the same set again writes no code, kicks nobody and returns []`; `refused with "AI roles can only be changed before the start" after the start, while the start is in flight and after the end, nothing changed`; `refused with "not a player role of this session" for client_sponsor, "ghost" and tech_lead twice`; `refused with "at least one player role must stay human" for all three player roles`; `a failed seat write restores credential, consent and AI set, puts the old codes file back, and the old code still opens the seat`; `the roster is re-sent with ai true for a switched role nobody held`; `nothing is appended to the log`.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `reissue*.test.ts`; expect PASS. Mutations: no code rotation (old-code test); persisting before the codes write; kicking with 4002 for a switch to AI.
- [ ] **Step 5:** Commit `[feat] US-0060: switch roles to AI players before the start`; then `ai-roles.socket.test.ts` in the node:22 container (root and `--user node`).

### Task 8: The IPC on both sides

**Files:** Modify `services/runtime/src/host/parent-channel.ts`, `services/runtime/src/main.ts` (dispatch by `m.type`; `ready.aiRoles`), `services/control/src/protocol.ts`; Test `services/runtime/src/__tests__/main.ai-roles.test.ts` (new; `fakeParent` and `boot` of `main.parent.test.ts`), `host/__tests__/parent-channel.test.ts`, `services/control/src/__tests__/protocol.drift.test.ts`.

**Interfaces:** schemas per Global Constraints (identical in both files). `main.ts`: `set_ai_roles` runs `setAiRoles` with the same deps as the reissue branch plus `server`, answering `ai_roles_set { requestId, codes }` or `ai_roles_failed { requestId, reason }` (`AiRolesRefusedError.reason`, else `AI_ROLES_REFUSED.failed`); the synchronous catch answers with the failure type of the message's own `type`; `ready` carries `aiRoles: host.aiRoleIds()` when non-empty.

- [ ] **Step 1: Write the failing tests:** `set_ai_roles ["tech_lead"] answers ai_roles_set with one code that opens tech_lead, and the code issued at create is refused`; `a refused set_ai_roles answers ai_roles_failed with the fixed reason, never a path or a role id`; `a managed restart of the lobby sends ready with aiRoles ["tech_lead"]; a session without AI roles sends ready without the key`; `a resumed started session sends ready with aiRoles from its log after the AI-role file was deleted`; `a reissue still answers reissued as before`; parent-channel: `set_ai_roles with an extra key, a reserved role id, 257 roles or roles as a string is dropped`; drift: the accept and reject tables gain `set_ai_roles`, `ai_roles_set`, `ai_roles_failed` and `ready` with `aiRoles` (each valid and one invalid case).
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `main.parent.test.ts`, `main.reissue.test.ts`, `main.managed.test.ts` and typecheck (both packages); expect PASS. Mutations: the control copy without `.max(MAX_CODES)`; answering every failure as `reissue_failed`.
- [ ] **Step 5:** Commit `[feat] US-0060: set_ai_roles over the control channel`; then `main.ai-roles.test.ts` in the node:22 container (root and `--user node`).

### Task 9: The supervisor's `setAiRoles` (no HTTP route)

**Files:** Modify `services/control/src/supervisor.ts`; Test `services/control/src/__tests__/supervisor.ai-roles.test.ts` (new; `fake-child.ts`), `api.test.ts`.

**Interfaces:** `Supervisor.setAiRoles(id: string, roles: string[]): Promise<{ roleId: string; code: string }[]>`: `not_found`; `bad_request` when `ParentMessageSchema` refuses the message; `conflict` "the session is not running"; one per session (`conflict` "the AI roles are already being changed", nothing sent); pending entry like `pendingReissues` under `withLock`; `ai_roles_failed` is `conflict` with its reason; timeout (`reissueTimeoutMs`) is `timeout` "the AI roles may or may not have changed; reissue the changed roles"; child exit is `unavailable`. `Supervisor.aiRolesOf(id: string): string[]` (from the latest `ready.aiRoles` or successful set; `[]` when unknown). `api.ts` unchanged.

- [ ] **Step 1: Write the failing tests:** `setAiRoles sends set_ai_roles with a fresh requestId and resolves with the codes of the matching ai_roles_set`; `ai_roles_failed is a conflict carrying the runtime's reason`; `a reply with another requestId or from an earlier child is ignored`; `the timeout rejects with timeout and a late reply changes nothing`; `a child exit rejects with unavailable`; `a second call while one is pending is conflict and sends nothing`; `["tech_lead", 7] and "Tech_Lead" are bad_request and nothing is sent`; `aiRolesOf follows ready.aiRoles and a successful set, and a failed set leaves it`; api: `no control route sets AI roles: POST and PUT /sessions/:id/ai-roles are 404` (pins A1).
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run the control suite; expect PASS. Mutations: not clearing the pending entry on exit; resolving on any `ai_roles_set`.
- [ ] **Step 5:** Commit `[feat] US-0060: the control service can set AI roles over IPC`.

### Task 10: PR 2 docs and pull request

**Files:** Modify `docs/THREAT_MODEL.md` (new section "AI-role state (slice 2b-3a, US-0060)"), `docs/ARCHITECTURE.md`, `README.md` (close code 4004), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Threat model: parent-only IPC; code rotation and why (A2); persist order (A3); AI seats skip consent and get no notice; the reserved prefix and labels from `aiRoles` (A7); nothing reachable from HTTP yet (A1); the 2b-3b obligations of "Notes for 2b-3b" below. Architecture: the IPC, gate and roster flag. CHANGELOG "Added".
- [ ] **Step 2:** Assign the next free ids (expected AC-0359, TC-0101, TC-0102). `AC-0359: the control service can set the AI roles of a session before the start over the private IPC channel only; each changed role gets a new code in the same step, a switched human's credential and consent are revoked and their socket closed with 4004, and the change is refused after the start` (checked, TC-0101). Tick AC-0320 (TC-0102: Tasks 5, 6; note "the console shows the two counts in 2b-3b"). AC-0317 and AC-0318 notes: "runtime part built in 2b-3a (fixed after the start; revoke, rotate, close); toggle, confirmation and the new code shown once in 2b-3b".
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage`; commit `[docs] US-0060: document the AI-role gate and IPC`.
- [ ] **Step 4:** Push, open PR 2 into `develop` (body: US-0060, AC-0320, AC-0359, TASK-0098). Wait for the squash merge before PR 3.

---

## PR 3: consent notice v2 and the player page (`feature/EPIC-0002-US-0060-ai-role-labels`, from `develop` after PR 2)

### Task 11: Consent notice v2 without locking out running sessions

**Files:** Create `consent/notice-v2.md`; Modify `services/runtime/src/main.ts:110` (default `"v2"`), every bootstrap-based test that sends `noticeVersion: "v1"` against the default (find them with `git grep -n 'noticeVersion: "v1"'` in files that call `bootstrap`, e.g. `hub.runtime.test.ts:399`, `main.parent.test.ts:86`: send the version from `joined.consent.noticeVersion`); Test `services/runtime/src/__tests__/main.test.ts`, `main.consent-v2.test.ts` (new; `fakeParent`, managed, real files, `consentDir` holding both notices).

- [ ] **Step 1: Write the failing tests:** `without CONSENT_NOTICE_VERSION a player's joined offers v2, whose text contains "named “AI player”"`; `notice-v1.md still has sha256 7dde9e1e98d74b1f7b5943f96e6b808aad074d154e50b8224ee66d6f026b2b09`; `a started session whose players consented under v1 restarts on v2: both humans rejoin with their credentials, a different participant for account_manager is refused consent_required, a bot rejoins tech_lead with a reissued code, and the log still starts with logFormat 3 and aiRoles ["tech_lead"]`; `a lobby whose players consented under v1 restarts on v2: seats and the AI role are kept, the v1 consents are dropped, and start is refused "seats_not_ready: account_manager,delivery_lead"` (bot connected).
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement (notice text per Global Constraints).
- [ ] **Step 4:** Re-run the runtime suite and the web `*.runtime.test.ts` files; expect PASS. Mutation: `adopt` comparing the notice version (the started-session test must fail).
- [ ] **Step 5:** Commit `[feat] US-0060: consent notice v2 names AI player seats`; then `main.consent-v2.test.ts` in the node:22 container (root and `--user node`).

### Task 12: The BFF: reserved names, 4004 and a picked peer roster

**Files:** Modify `apps/web/src/server/{handlers,runtime-connection,stream-hub,wire}.ts`; Test `handlers.test.ts`, `runtime-connection.test.ts`, `stream-hub.test.ts`, `wire.test.ts`.

**Interfaces:** `A.reservedName = { status: 400, code: "reserved_name", message: "Names starting with “AI player” are kept for AI players. Choose another name." }` checked with `isReservedDisplayName` right after `displayName()` (`handlers.ts:180`), before the throttle and the runtime; `CLOSE_AI_FILLED = 4004` → close kind `"ai_filled"`; `AI_FILLED_MESSAGE = "The facilitator has filled this role."`; the hub treats `ai_filled` as terminal exactly like `removed` (final SSE event, cookie handling as for `removed`); `peerEntryOf(e): PeerRosterEntry` picks `roleId`, `name` (capped at 60 code points), `ready === true`, `ai: true` only when `e.ai === true`; `wire.ts` entries gain `ai?: true`. The console `entryOf` is unchanged (it lists `ai` in 2b-3b, A6).

- [ ] **Step 1: Write the failing tests:** `a join named "AI player Sam" is 400 reserved_name and the runtime is never contacted`; `a 4004 close is ai_filled; 4003 is still removed`; `an ai_filled close ends the player stream with the ai_filled event and AI_FILLED_MESSAGE`; `a peers roster entry keeps ai true; ai "yes", an extra key "participantId" and a non-boolean ready are dropped or false`.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run the web suite; expect PASS. Mutation: forwarding roster entries verbatim (the extra-key case).
- [ ] **Step 5:** Commit `[feat] US-0060: the web server reserves AI player names and picks roster fields`.

### Task 13: The player page labels AI players

**Files:** Modify `apps/web/src/lib/{use-session,messages}.ts`, `components/{Transcript,Roster,SessionScreen}.tsx`; Test `apps/web/src/components/__tests__/{components,session-screen}.test.tsx`, `apps/web/src/lib/__tests__/use-session.test.ts`.

**Interfaces:** `toRoster` picks the four fields (default deny); `FinalKind` gains `"ai_filled"` (in `CLOSING_EVENTS`); `MESSAGES.aiFilled`; `TranscriptProps.aiRoles: ReadonlySet<string>` (from `view.aiRoles`): a line whose role is in it reads "AI player" with the pill "AI" and the muted role label, whatever the roster names it; Roster shows an `ai` entry as "AI player" with its role label and "Ready" / "Not joined"; the final title per Global Constraints. Text children only, no `dangerouslySetInnerHTML` (`source-rules.test.ts`).

- [ ] **Step 1: Write the failing tests:** `a line from tech_lead reads "AI player" with the AI pill and "Tech lead" even when the roster names tech_lead "Pat"`; `a human player's line has no AI pill and an AI character's line keeps it`; `the roster shows an ai seat as "AI player" with "Tech lead" and Ready`; `the ai_filled final shows "Role filled by an AI player" and "The facilitator has filled this role." and no say box`; `MESSAGES.aiFilled equals AI_FILLED_MESSAGE`; `toRoster drops unknown keys and keeps ai only when true`.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `src/__tests__/source-rules.test.ts`; expect PASS. Mutation: deriving the label from the name (the "Pat" case).
- [ ] **Step 5:** Commit `[feat] US-0060: the player page marks AI player seats and lines`.

### Task 14: Real-runtime contract for AI seats

**Files:** Create `apps/web/src/server/__tests__/ai-roles.runtime.test.ts` (harness of `hub.runtime.test.ts` with `CONTROL_MANAGED=1` and the `fakeParent` of `main.parent.test.ts`; a raw ws client is the bot, joining `tech_lead` with the `ai_roles_set` code and `issueCredential: true`).

- [ ] **Step 1: Write the tests:** `each human's player stream carries session.started with aiRoles ["tech_lead"] and the bot's line "BOT-LINE-41" with roleId tech_lead`; `a human whose stream reconnects after that line gets a reset whose view has aiRoles ["tech_lead"]`; `no player stream byte carries the bot's participant id, credential or code, the names table or a consents entry for tech_lead` (markers proven on the facilitator socket or the IPC reply); `a join through the BFF named "AI player Sam" is 400 reserved_name`; `switching account_manager to AI before the start ends its stream with ai_filled and its cookie's next stream is refused`.
- [ ] **Step 2:** Run the file; these are contract tests over Tasks 1 to 13 and may pass at once; break `startedForPlayer` on purpose (drop `aiRoles`) and see the first test fail. A real failure is fixed in code, never in the assertion.
- [ ] **Step 3:** Commit `[test] US-0060: AI seats against the real runtime`; then the file in the node:22 container (root and `--user node`).

### Task 15: PR 3 docs, pull request and close-out

**Files:** Modify `docs/THREAT_MODEL.md` ("Consent notice versions": v2 default and status; reserved name; the 4004 screen), `README.md` (`CONSENT_NOTICE_VERSION` default v2), `.env.example`, `docs/ROLLBACK.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`, `docs/memory/architecture-and-security.md`.

- [ ] **Step 1:** Assign the next free ids (expected AC-0360, TC-0103, TC-0104). `AC-0360: the default consent notice is v2, which says a participant's seat may be played by an AI player, and a started session whose players consented under v1 is not locked out after a restart on v2` (checked, TC-0103). TC-0104 (AC-0321, player part: Tasks 6, 12, 13, 14); AC-0321 note "player transcript and roster built in 2b-3a; console, reports, exports and the intent log follow in 2b-3b, 2b-3c and 2c". AC-0322 note "2b-3c and 2c read state.aiRoles from the log (2b-3a)". TASK-0098 Done (three PRs); US-0060 stays In Progress.
- [ ] **Step 2:** ROLLBACK: a build before this slice serves notice v1 again; a lobby's v2 consents are dropped on read (everyone agrees again) and a started session keeps the consents its log recorded (R14). CHANGELOG "Changed" (notice v2) and "Added" (labels). `progress.md`, `MEMORY.md`, memory file: the IPC, rotation, file, format 3, gate, labels and the "Notes for 2b-3b".
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage` twice (once under load, `yes` x8); the whole `pnpm --filter @acr/web e2e` once (the default notice changed; chromium per the 2b-2b2 plan); record results in `progress.md`. Commit `[docs] US-0060: document notice v2 and close 2b-3a`.
- [ ] **Step 4:** Push, open PR 3 into `develop` (body: US-0060, AC-0321 progress, AC-0360, TASK-0098). After the merge the 2b-3b plan is written next.

## Notes for 2b-3b (hard limits it inherits)

1. Refuse more than 12 player roles at create (`2H + B + 7 <= 32` sockets); a reconnecting bot must never hold two sockets (progress.md Sessions 15 and 16).
2. Never return an AI role's code to the BFF (reissue, reissue-all, create); keep bot codes and credentials in control-service memory. `reissueAll` and any codes reissue remove the AI-role file with the seats, so re-send `set_ai_roles` afterwards.
3. After a `set_ai_roles` timeout the codes may have rotated: reissue each changed role before using or showing a code (A11).
4. Add the HTTP and BFF routes only with the bot host and the toggle (A1); the console readiness lists `ai` in `entryOf` and words AI rows apart from `seats_not_ready` humans (A6); the console timeline labels from `state.aiRoles`.
5. The bot intent log stays facilitator-only, with a leak scan of every player frame; the bot joins without `displayName` (its name is fixed).
6. The terminal client's render does not label AI players yet.

## Pre-flight scan

| Pair or task | Produces → consumes, or tests vs code |
|---|---|
| 1 → 2 | `session.started.aiRoles`, `SessionState.aiRoles` → engine start and restore (Task 2 also owns `LOG_FORMAT = 3` and `logFormatFor`) |
| 1 → 6, 13, 14 | `SessionState.aiRoles`, `PlayerView.aiRoles`, player copies → roster frames, `Transcript`, contract test |
| 1 → 5, 12 | `isReservedDisplayName`, `AI_PLAYER_NAME` → runtime join, BFF join |
| 2 → 5, 8 | `SessionStartExtra.aiRoles`, `ResumeInfo.startedAiRoles` → gate, `ready.aiRoles` after resume |
| 3 → 5, 7, 8 | `Seats.aiRoles` (`AiRoleSet`), persist order → `isAiRole`, `setAiRoles`, managed restart |
| 5 → 6, 7 | `isAiRole`, `aiRoleIds` → `buildRoster`, `setAiRoles` |
| 7 → 8 → 9 | `setAiRoles`, `AiRolesRefusedError.reason`, `CLOSE_AI_FILLED` → IPC answers → supervisor; 7 → 12 close 4004 |
| 8 (runtime) ↔ 8 (control) | `parent-channel.ts` and `protocol.ts` schemas are equal (drift test, same commit) |
| 12 → 13 | `AI_FILLED_MESSAGE`, `ai_filled` kind, picked `ai` flag → `MESSAGES.aiFilled`, `FinalKind`, Roster |
| Task 1 | Pinned snapshot gains only `aiRoles: []`; format constants untouched, so every format test stays green |
| Task 2 | `state.test.ts:229`, `session-engine-restore.test.ts:148-160` and the `:235` "3 is refused" case (now 4) change in the same commit as `LOG_FORMAT = 3` |
| Task 3 | `Seats.aiRoles` optional: existing `Seats` literals in tests still compile; store always sets it |
| Task 5 | Gate message order matches "humans then AI"; `ws-server.consent.test.ts` cases without AI roles unchanged |
| Task 6 | `ai` key absent for humans, so `ws-server.roster.test.ts:74` exact entries stay valid |
| Task 7 | Tests expect 4004 for to-AI and 4002 for to-human, as the code's kick table |
| Tasks 8, 9 | Drift tables list the same accepted and refused messages the schemas encode; api 404 test matches the unchanged router |
| Task 11 | Tests that hardcode "v1" against the default are changed in the same commit as the default |
| Tasks 12, 13 | `toRoster` and `peerEntryOf` pick the same four fields |

## Open questions for the owner

1. **Notice v2 wording** (Global Constraints, "Consent notice v2"). Recommendation: approve the proposed paragraph as written; it adds only the AI-seat sentence and the "AI player" naming promise. Cost if wrong: a later meaning change needs v3, and every lobby consents again.
2. **Bump the notice in 3a or with the bot in 3b** (A9). Recommendation: 3a, so no build can fill a seat with an AI under a notice that does not say so. Cost if wrong: lobbies open during the 3a upgrade click "I agree" once more for a feature they cannot see yet.
