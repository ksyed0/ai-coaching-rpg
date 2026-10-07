# Migration Log

Cross-platform changes that still need to be applied (AGENTS.md section 14, step 5).

There are none pending. Only one platform exists today: the text-only terminal runtime (Node 22, `pnpm` monorepo). Web lobby (EPIC-0002), voice (EPIC-0003) and 3D (EPIC-0004) are Planned and have no code. When one of them starts, list here every behaviour of the terminal runtime that the new client must mirror, for example:

- the facilitator commands (`/start /pause /resume /advance /inject /whisper /hidden /release`) and the protocol messages behind them (`services/runtime/src/host/protocol.ts`);
- reconnect and rejoin: roles are claimable again after a restart, and a rejoining client receives only its filtered transcript (US-0013 would add the missed injects and whispers);
- the facilitator token (`join_facilitator`), the Origin check and the per-connection limits;
- the `log_failed` notice a client gets when the server fail-stops;
- the `notice` field on the facilitator's `joined` message when the server is open;
- the draft evaluation reports and their prototype visibility setting.
- player join codes (US-0033): a `join` for a player role must carry `joinCode` (at most 64 characters, Crockford base32, case, spaces and hyphens ignored, O/I/L folded); a refusal is one generic `unauthorized` and the connection closes (1008), so a web or voice client needs a code-entry step and must not echo the code; the facilitator needs no code; a live takeover needs the reconnect token. The terminal client takes the code from `JOIN_CODE`, `--code-file` or a hidden prompt, never argv.
