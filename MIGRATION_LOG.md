# Migration Log

Cross-platform changes that still need to be applied (AGENTS.md section 14, step 5).

There are none pending for an existing platform (the US-0013 entry below lists what future clients must mirror). Only one platform exists today: the text-only terminal runtime (Node 22, `pnpm` monorepo). Web lobby (EPIC-0002), voice (EPIC-0003) and 3D (EPIC-0004) are Planned and have no code. When one of them starts, list here every behaviour of the terminal runtime that the new client must mirror, for example:

- the facilitator commands (`/start /pause /resume /advance /inject /whisper /hidden /release`) and the protocol messages behind them (`services/runtime/src/host/protocol.ts`);
- reconnect and rejoin: roles are claimable again after a restart (with their join codes); a rejoining client receives its filtered transcript and, when its join carries `lastSeq`, the missed events (see the US-0013 entry below);
- the facilitator token (`join_facilitator`), the Origin check and the per-connection limits;
- the `log_failed` notice a client gets when the server fail-stops;
- the `notice` field on the facilitator's `joined` message when the server is open;
- the draft evaluation reports and their prototype visibility setting.
- player join codes (US-0033): a `join` for a player role must carry `joinCode` (at most 64 characters, Crockford base32, case, spaces and hyphens ignored, O/I/L folded); a refusal is one generic `unauthorized` and the connection closes (1008), so a web or voice client needs a code-entry step and must not echo the code; the facilitator needs no code; a live takeover needs the reconnect token. The terminal client takes the code from `JOIN_CODE`, `--code-file` or a hidden prompt, never argv.

## 2026-10-07: replay-from-seq on rejoin (US-0013)

- **Files:** `services/runtime/src/host/protocol.ts` (`lastSeq` on `join` and `join_facilitator`, `ReplaySummary` on `joined`), `host/ws-server.ts`, `host/session-host.ts` (`replayFor`, `MAX_REPLAY_EVENTS`, `MAX_REPLAY_BYTES`), `engine/recent-events.ts`, `engine/session-engine.ts` (`eventsAfter`), `cli/commands.ts`, `cli/client.ts`, `cli/render.ts`.
- **Applies to:** every future client (web lobby EPIC-0002, voice EPIC-0003, 3D EPIC-0004). The terminal client has it; nothing else exists yet.
- **What a client must do.** Keep the highest event `seq` it has received (or the `state.lastSeq` of its last `joined` snapshot if no event arrived since) and send it as `lastSeq` when it rejoins, in the same `join` / `join_facilitator` it sends today (join code or reconnect token or facilitator token unchanged). Old value: no field, the client got only its snapshot (its scenes' transcript). New: the `joined` reply carries `replay: { afterSeq, toSeq, events, complete }`; exactly `events` event frames follow at once, before any live event, holding the events with seq in `(afterSeq, toSeq]` its role may see, oldest first. `toSeq` equals the snapshot's `state.lastSeq`; every later frame has a higher seq. Render the snapshot's history only up to `afterSeq` (later lines arrive as replayed events) and drop any event frame whose seq is not above the last one received (the server sends none; it is a guard).
- **`complete: false`** (`events: 0`): the client was further behind than the server replays (older than the last 4096 events, or more than 1000 events or 256 KiB for its role). Treat the snapshot as a full resync and tell the user that earlier injects and whispers are not shown.
- **Errors.** A `lastSeq` that is not a whole number from 0 to 2^53-1 is `bad_message` (before authentication); one past the session's last event is `bad_message` once the join is authorised (nothing claimed): rejoin without `lastSeq` (it happens after `SESSION_START=fresh` started a new log under the same session id). A refused join (`unauthorized`, `role_taken`) gets nothing else.
- **Restart.** Seqs come from the session log and continue across a restart, so the same `lastSeq` works after the server restarted; players are then replayed `session.resumed` (the restart alert is facilitator-only).
- **Still to do per platform:** the web lobby (EPIC-0002) must persist the last seq across a page reload (for example in `sessionStorage`) and reconnect automatically; the terminal client exits on a drop and prints `--last-seq <n>` instead of reconnecting by itself.
