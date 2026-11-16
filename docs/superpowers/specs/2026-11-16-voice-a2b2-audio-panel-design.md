# Voice slice A2b-2: facilitator audio review and delete panel (control transcript route, web routes, console panel) (design)

Status: Draft 2, approved by the owner 2026-11-16 (after an independent builder check; 4 questions, all settled in the doc as builder calls). Parents: `2026-11-12-voice-a2b1-audio-replay-delete-design.md` (sections 5 to 7 stay in force), `2026-11-13-voice-a2b1b-audio-delete-design.md`, `2026-11-13-facilitator-accounts-design.md`, `docs/THREAT_MODEL.md`. A2b-1a (US-0074, PR #139) and A2b-1b (US-0075, PR #141) are merged, and so are facilitator accounts (US-0083, PRs #142 and #144). Story: US-0090 (TASK-0142, AC-0540 to AC-0549, TC-0310 to TC-0321), filed 2026-11-16, EPIC-0003, dark behind `VOICE_ENABLED`. Live partials, mute and consent (A3) stay a separate slice.

## 1. Intent and why

After a session ends, the facilitator can listen back to what was recorded, read what was transcribed beside each clip, and delete audio (one participant, one role, or the whole session) before the client leaves the room. The control API for listing, replay and delete exists and is audited; nothing in the web console can reach it. This slice adds that last step.

**Decided by the owner (2026-11-16):**
1. The panel is used **after the session ends**, to review and delete before the client leaves. It sits beside the report panel in the after-end block of the session console. No live use.
2. Each clip row shows **its transcript line** (the clips-with-transcript layout).
3. The transcript comes from a **new, separate control route**, `GET /sessions/:id/transcript`. The audio listing and its A2b-1a contract stay unchanged; the web server joins the two.
4. **A shared-secret (legacy) sign-in cannot play or delete audio.** The panel says "sign in with your own account to hear or delete recordings". Every audit name comes from a real account, built on the server.

## 2. Goals, non-goals, anti-goals

Goals: `GET /sessions/:id/transcript` in control; four web server routes (combined list, play, delete) behind the existing per-session ownership guard; the console `AudioPanel`; THREAT_MODEL, VOICE_RUNBOOK, ROLLBACK, CHANGELOG and tracker updates; unit, real-HTTP and component tests with mutation checks.

Non-goals: a participant-id delete in the UI; live listening or live deletion; per-clip delete (scopes stay session, role, participant); un-delete; editing or deleting transcript text; any change to the audio listing, replay or delete contracts; participant-facing audio access; downloading audio to disk; a typed-name path for shared-secret sign-ins; per-address throttles beyond the existing per-account pattern.

Anti-goals (a failure even if it technically works): a play that returns bytes with no audit line; one play logged several times (or not at all) because the browser asked in ranges or retried; any audio byte, file path, identity folder or transcript text in a log line, audit line or cache; a delete confirmation that does not say what goes and that it cannot be undone; a panel that implies something was deleted when control reported it pending; a name typed by a user reaching an audit line; transcript text of one session shown for another.

## 3. Constraints

Control keeps every rule of the parents: open-then-check file reads (no `js/file-system-race`), no hand-written id regexes (`isFileSafeId`, `isLowerHex`, `isValidSessionId`; the runtime `id-rules.files.test.ts` scans), nothing logs a path, an id, an identity or a name. The web server never talks to control except through `launcher-client.ts`; the browser never sees control's address or token. Web routes go through the shared per-session ownership `guard` (owner or admin; a neutral 404 for anyone else) and the account cookie re-check, exactly like the report routes in `console-report-handlers.ts`. `by` is built on the server as `accountSlug(name, id)` plus the `-console` form the control `parseBy` expects, and any `by` in a request body is ignored. Responses carrying audio or transcript text are `Cache-Control: no-store`. Control and web still deploy control first, then web; this slice adds a control route that the new web code needs, so web must not ship before control (recorded in ROLLBACK).

## 4. Control: `GET /sessions/:id/transcript`

Service token (401 before any file call); `:id` validated with `isValidSessionId` (404 on a bad id); `X-Acr-By` is not required (no audio is involved and no audit line is written). Facilitator-only, like the audio routes.

**What it returns.** The spoken lines of the session log: `{ lines: [{ seq, ts, roleId, text }], truncated: false }`, in log order, where `seq` is the log position, the same number the audio listing carries as `seq` on a segment. Only `utterance` events are returned; every other event type is skipped. A line carries no `channel`, no scene and no other field (field by field, as the audio listing does).

**How it reads.** A new reader beside `voice/log-identity.ts`, `<sessionsDir>/<sessionId>.jsonl`, opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and judged through `fstat` on the descriptor (a regular file of this user). The file is read in bounded chunks and parsed line by line; a torn or unparseable line is skipped. A hard cap on file size (default 8 MiB, configurable) and on returned characters: a log over the cap answers **413 `transcript_too_large`**, never a partial list, so the panel can say "the transcript is too long to show here; the clips are still listed". A missing log is 404 `not_found`, as the audio routes answer for a session with no audio. A session that is live is **409 `session_live`**, the same code and body shape as delete. *(Builder-check call.)* "Live" means the supervisor does not report the session as ended **or** `VoiceHost.isLive` is true, through the same fail-closed `liveNow` the audio service already uses for delete. It is deliberately the same answer delete gives, so the panel never offers a delete that control would refuse, and the log is never read while it is still being written. A session ended while its voice host is still draining is 409 for a short while (the panel's "try again in a moment"). The audio list and play routes keep not asking the supervisor.

**Limits.** An in-flight cap (default 4, 503 `busy` with `Retry-After: 1` over it) because the read is synchronous. No audit line (no audio is read).

## 5. Web server routes

All under the console session path, all `route()`-wrapped, all through the per-session guard; the owner-or-admin check and the account cookie re-check happen first, then the legacy refusal, then control.

| Route | Does | Notes |
| --- | --- | --- |
| `GET .../audio` | One call that lists the audio and the transcript and joins them. | Returns `{ recordingStopped, clips: [{ id, role, participantId, startMs, endMs, status, audio, text? }], tooLongForText?: true }`. `id` is an opaque handle the web server maps to `{ identity, role, segment }` (never the identity folder name); `role` is the clip's role id, the same id the console roster uses. *(Builder-check call, join rule.)* `text` is present only when the clip's `status` is `transcribed`, the clip has a `seq`, a transcript line with that `seq` exists, and that line's `roleId` equals the clip's `role`; a mismatch drops the text (another seat's words are never shown). Clips with status `empty`, `stt_failed` or `refused:*`, or with no `seq`, show "no transcript". |
| `GET .../audio/play?clip=<id>` | Fetches one WAV from control with the server-built `by` and passes it through. | `200 audio/wav`, `Cache-Control: no-store`, `Accept-Ranges: none`, `X-Content-Type-Options: nosniff`; control's error codes mapped (410 `audio_deleted`, 503 `audit_unavailable`, 503 `busy` with `Retry-After`). |
| `POST .../audio/delete` | Body `{ scope, reason }`, scope being `{ kind: "session" }` or `{ kind: "role", role }` (a role id taken from the list; nothing else is accepted); forwards to control's `DELETE` with the server-built `by`. | *(Builder-check call.)* Mirrors control's status and body envelope: 200 when everything is done, 503 with the same `{ deleted, identities, pending }` body when anything is pending (worst reason as the error code), 409 `session_live`. The panel's client reads the body of a 503 and a 409; it never treats a non-2xx answer as "nothing happened". |

**The legacy refusal.** A cookie of kind `legacy` gets `403 account_required` from all three, before any control call, and the panel shows the sentence in section 1. Nothing is sent to control for such a sign-in.

**The join.** Control's listing and transcript are fetched in parallel. A transcript failure other than 413 does not fail the list: the clips come back without text and the response carries `textUnavailable: true` (the panel shows "transcripts unavailable right now"). A 413 sets `tooLongForText`. The session being live (control 409) makes the whole route answer 409 `session_live`, shown as "the session is still ending, try again in a moment". Fewer than zero clips is a normal `{ clips: [] }` (the panel shows "no recordings"); a control 404 for audio is the same.

**Throttles.** The existing `JoinThrottle` pattern keyed by account (`account\0<id>`), never by cookie for an account sign-in: a read limit for list and play (play looser, since a facilitator may skip through clips), a stricter write limit for delete. Over the limit is 429 with `Retry-After`, in the panel's words.

## 6. Console panel

`AudioPanel` renders after the session ends, in the after-end block with `ReportPanel` and `ReportLinksPanel`, only when `VOICE_ENABLED` (the same flag the voice panel uses). It loads the combined list on mount and after every delete.

```
Recordings                                each play is logged
Dana (Tech lead)                          [Delete this seat's audio]
  0:42  "I think we should move the deadline…"          ▶
  1:10  (no transcript)                                  ▶
Sam (Client lead)                         [Delete this seat's audio]
  0:55  "Agreed, but only if…"                           ▶
                                          [Delete all audio]
```

- **Rows** are grouped by seat, that is by the clip's role id, with the name from the console roster (`roleId`, `name`); a role id the roster does not know is shown by its id. Rows are ordered by start time; the time is the clip's start within the session. *(Builder-check call.)* A clip's `participantId` is a per-join identity the roster cannot name (a seat can be rebound), so the UI does not group or delete by it.
- **Play** fetches the clip through the play route into a Blob and plays it through one labelled `<audio>` element. One clip at a time: starting a second stops the first. A "plays are logged" note sits at the top (one fetch, one audit line; no range requests, no direct media URL).
- **Delete** has two scopes in the UI: a seat (the group's role) and all audio of the session. Control's participant scope stays API-only; a participant who asks to be deleted is covered by deleting their seat. Each opens an inline confirmation naming what goes ("Dana's 14 clips, 6 min 10 s") and saying it cannot be undone, with a reason choice defaulting to "facilitator decision" and "participant asked" as the alternative, and a confirm button. No modal. Focus returns to the row (or the panel heading when the row is gone) after a delete.
- **Results.** A fully done delete reloads the list (deleted clips show "audio deleted", not playable; the transcript stays). A pending result (503) lists which parts were not deleted and why in plain words (`busy` "try again", `store_unsafe` and `audit_unavailable` "this needs the operator"), keeps those clips playable-looking only if control still lists them, and offers Retry (safe: control skips what is already marked).
- **States:** loading; "no recordings"; "the session is still ending, try again in a moment" (409); "sign in with your own account to hear or delete recordings" (legacy); "transcripts unavailable" and "transcript too long" (clips still shown); a clip that returns 410 flips to "audio deleted" without a reload.
- **Accessibility:** native buttons; the audio element has a label naming the clip; confirmation and result messages are announced through `role="status"` (errors `role="alert"`); every control is reachable by keyboard.

## 7. Approaches considered

- **Where the transcript comes from:** (1) join inside control, so the audio listing grows a `text` field (rejected by the owner: changes the A2b-1a contract and puts conversation text on an audio-only route); (2) a separate control transcript route joined by the web server by `seq` — CHOSEN by the owner; (3) the web server reads the session log itself (rejected: the web server has no access to control's files and must not).
- **Playback:** (1) fetch the WAV into a Blob through the play route and play it from memory — CHOSEN; one request is one audit line, and the clip cap (512 KiB) makes it cheap; (2) point an `<audio src>` at the route (rejected: the browser sends range and retry requests, so plays would be logged several times or not at all, and the route answers whole files only); (3) stream (rejected: control answers whole files by design).
- **Shared-secret sign-ins:** (A) refuse audio — CHOSEN by the owner; (B) ask for a typed name each time (rejected: an audit trail holding a name anyone could type).
- **Delete confirmation:** inline confirmation naming the scope and its irreversibility — CHOSEN; a modal was rejected as more focus-management risk for no gain.

## 8. Tests and verification

Control: transcript route cases (bad id 404, no token 401, missing log 404, live 409, over-cap 413 never partial, torn last line skipped, only utterances returned, field-by-field output, in-flight cap 503); the reader refuses a link, a non-file and another user's file. Web: legacy cookie gets 403 from all three routes with no control call; owner-or-admin guard gives a neutral 404 for another account; `by` is built on the server and a body `by` is ignored; the join (a clip with no `seq`, a `failed` clip, a clip with no matching line, a transcript failure giving `textUnavailable`, a 413 giving `tooLongForText`); play passes bytes through with `no-store`; control 410/503/busy mapped; delete returns a partial result as pending, not success; throttle keyed by account. Component: states in section 6, one clip playing at a time, confirmation naming scope and irreversibility, focus return, retry after pending. Mutation checks, each failing a named test: the legacy refusal, the server-built `by`, the `no-store` header, the join by `seq`, the partial-result handling.

## 9. Left to the builder

File and function names (suggested: `services/control/src/voice/transcript.ts`, `apps/web/src/server/console-audio-handlers.ts`, `apps/web/src/components/console/AudioPanel.tsx`); how the opaque clip handle is built and mapped (stateless signed handle, or an index into the latest listing held by the route); the transcript size and character cap values; the exact wording of the states; how the rate limits are tuned; the story, AC, TC and TASK ids.

## 10. Risks and residuals

Playing a clip holds its bytes in browser memory until the page is left (accepted: 512 KiB per clip). A delete that is pending for `store_unsafe` or `audit_unavailable` cannot be fixed from the panel; it needs the operator (VOICE_RUNBOOK gains the matching entry). The transcript route reads a log synchronously; the size cap and the in-flight cap bound it, and an async reader is a recorded follow-up. A facilitator who is not the session's owner but is an admin can hear and delete a session's audio (same rule as every other console write); the audit line names them.
