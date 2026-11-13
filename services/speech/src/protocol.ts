import { closeSync, constants as fc, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isFileSafeId, isReservedRoleId, isScenarioId } from "@acr/events";

/**
 * US-0070 (EPIC-0003 voice A1a): the speech worker's fork() IPC messages to and from the control service. The ONE source of these
 * schemas: control imports this module as `@acr/speech/protocol` and nothing else of `@acr/speech` (a control import test pins it), so no
 * native audio code ever loads into control. This module imports only zod, @acr/events and node:fs (US-0075: the one index-line writer, below). Every schema is strict (unknown keys refused).
 *
 * The worker never talks to the runtime: control relays a `voice_line` to the runtime over the parent channel and gives the answer back
 * as `voice_line_result`. See docs/superpowers/plans/2026-11-08-voice-part-a-overview.md, "Cross-slice interfaces", section 1.
 */

/**
 * US-0071: the exit code of a worker whose LiveKit ingest failed or lost a room (a failed `room.open`, an unexpected disconnect of an
 * allowed room, JOIN_ATTEMPTS join misses, MAX_TRACK_RESTARTS track restarts, a fault in a room listener). US-0072 (A1c Task 10): the
 * ONE source, here, so control reads it (`@acr/speech/protocol`) to tell a possible LiveKit outage from any other exit; the worker's
 * main.ts imports it too.
 */
export const EXIT_LIVEKIT_LOST = 3;

/** The longest transcript line the worker may send (equals the runtime's MAX_UTTERANCE_CHARS). */
export const MAX_VOICE_TEXT_CHARS = 2000;
/** The most seats a `voice_state` may list (the parent channel's MAX_CODES). */
export const MAX_HOLDERS = 256;
/** The largest `silentMs` on a "speech stopped" edge. */
export const MAX_SILENT_MS = 60_000;
/**
 * The participant id that marks a seat released by a reissue after the start (the runtime's REBIND_PENDING, engine/consent.ts). Never a
 * real participant; refused wherever a participant id is carried. Control's drift test checks it equals the runtime's value.
 */
export const REBIND_PENDING_PARTICIPANT = "rebind-pending";

/** Why the runtime refused a voice line (the parent channel's VOICE_REFUSALS; control's drift test checks the two lists are equal). */
export const VOICE_REFUSALS = ["voice_off", "not_started", "unknown_role", "ai_role", "not_holder", "not_recording", "paused", "not_in_scene", "ended", "failed"] as const;
export type VoiceRefusal = (typeof VOICE_REFUSALS)[number];

/** A segment id: the worker makes it up (`randomBytes(8).toString("hex")`); a file-safe id, so it can later name an audio file. */
export const SegmentIdSchema = z.string().refine(isFileSafeId, { message: "invalid segment id" });
/** A role id: the parent channel's rule (scenario-id characters, at most CLIENT_ID_MAX_CHARS, never a reserved word). */
const RoleId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => isScenarioId(v) && !isReservedRoleId(v), { message: "invalid role id" });
/** A participant id: as the runtime's join message carries it, never the rebind marker. */
const ParticipantId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => v !== REBIND_PENDING_PARTICIPANT, { message: "invalid participant id" });
/** Wall-clock milliseconds from the worker's injected clock. */
const WallMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const WorkerReady = z.strictObject({ type: z.literal("worker_ready"), stt: z.enum(["ok", "unavailable"]) });
const VoiceLine = z
  .strictObject({
    type: z.literal("voice_line"), segmentId: SegmentIdSchema, roleId: RoleId, participantId: ParticipantId,
    /** Cleaned by the conservative normaliser (no word is rewritten). */
    text: z.string().min(1).max(MAX_VOICE_TEXT_CHARS),
    startMs: WallMs, endMs: WallMs,
  })
  .refine((m) => m.endMs >= m.startMs, { message: "endMs before startMs" });
/**
 * A track's speech edge. `silentMs` (milliseconds since the track's last speech frame) rides only on `active: false`, which the worker
 * sends only after the closing segment's line or failure has gone out (contradiction C3 of the overview).
 */
const SpeechActivity = z
  .strictObject({ type: z.literal("speech_activity"), roleId: RoleId, active: z.boolean(), silentMs: z.number().int().min(0).max(MAX_SILENT_MS).optional() })
  .refine((m) => !(m.active && m.silentMs !== undefined), { message: "silentMs only with active: false" });
const SegmentFailed = z.strictObject({
  type: z.literal("segment_failed"), segmentId: SegmentIdSchema, roleId: RoleId, participantId: ParticipantId, status: z.enum(["empty", "stt_failed"]),
});

/**
 * US-0071 (EPIC-0003 voice A1b): the LiveKit, health and slot messages (A1b plan, Task 2). Every id here is checked character by
 * character (no new regular expression): a room is "v" + 32 lower-case hex, a slot 16 lower-case hex.
 */
/** The longest LiveKit signalling URL control may send (`ws:` or `wss:`). */
export const MAX_LIVEKIT_URL_CHARS = 512;
/** The longest LiveKit access token control may send. */
export const MAX_LIVEKIT_TOKEN_CHARS = 4096;
const HEX_DIGITS = "0123456789abcdef";
/** True when `v` is exactly `length` lower-case hexadecimal digits. */
export const isLowerHex = (v: unknown, length: number): boolean => {
  if (typeof v !== "string" || v.length !== length) return false;
  for (const c of v) if (!HEX_DIGITS.includes(c)) return false;
  return true;
};
/** A seat's LiveKit room: "v" + 32 lower-case hex (control makes it up, one per session and human role). */
export const isVoiceRoomName = (v: unknown): boolean => typeof v === "string" && v.startsWith("v") && isLowerHex(v.slice(1), 32);
/** A speech-to-text slot id: 16 lower-case hex (the worker makes it up, `randomBytes(8).toString("hex")`). */
export const SlotIdSchema = z.string().refine((v) => isLowerHex(v, 16), { message: "invalid slot id" });
const RoomName = z.string().refine(isVoiceRoomName, { message: "invalid room name" });
/** A LiveKit signalling URL: `ws:` or `wss:`, no user info. */
const LiveKitUrl = z.string().max(MAX_LIVEKIT_URL_CHARS).refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "ws:" || u.protocol === "wss:") && u.username === "" && u.password === "";
  } catch { return false; }
}, { message: "invalid LiveKit url" });

/**
 * Asks control for a fresh token to the seat's room: sent whenever the ingest is about to connect that room (its first connect and every
 * reconnect, never cached). Control answers with `livekit_join` or `livekit_join_refused` (the worker's own wait covers a lost answer).
 */
const LiveKitTokenRequest = z.strictObject({ type: z.literal("livekit_token_request"), roleId: RoleId });
/** The worker's room connection changed. Control logs a fixed sentence only (no role, room or identity) and changes nothing else. */
const LiveKitStatus = z.strictObject({ type: z.literal("livekit_status"), state: z.enum(["connected", "failed", "disconnected"]) });
/** The result of one speech-to-text health poll. */
const SttHealth = z.strictObject({ type: z.literal("stt_health"), ok: z.boolean() });
/** Asks control for one of the global speech-to-text slots; control answers `stt_slot_grant` with the same slot when one is free. */
const SttSlotRequest = z.strictObject({ type: z.literal("stt_slot_request"), slot: SlotIdSchema });
/** Gives a granted slot back (or withdraws a waiting request). */
const SttSlotRelease = z.strictObject({ type: z.literal("stt_slot_release"), slot: SlotIdSchema });

/** US-0073: the worker's audio store stopped writing (disk low, or a write error); control alerts and stops retention. */
const StoreStopped = z.strictObject({ type: z.literal("store_stopped"), reason: z.enum(["disk_low", "write_error"]) });

/** The runtime must answer a voice line within this; otherwise control tells the worker `refused: "failed"`. */
export const VOICE_LINE_TIMEOUT_MS = 10_000;
/**
 * At most this many voice lines wait for the runtime per session: control refuses a line beyond it at once (the runtime is far behind),
 * and the worker (US-0073) holds at most this many segments' audio waiting for an answer, dropping the oldest unwritten beyond it.
 */
export const MAX_PENDING_LINES = 256;

export const WorkerMessageSchema = z.discriminatedUnion("type", [
  WorkerReady, VoiceLine, SpeechActivity, SegmentFailed, LiveKitTokenRequest, LiveKitStatus, SttHealth, SttSlotRequest, SttSlotRelease, StoreStopped,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

/** A seat generation: 8 lower-case hex (control's HMAC of role and participant under a per-session key, A1b Task 5). */
export const GenerationSchema = z.string().refine((v) => isLowerHex(v, 8), { message: "invalid generation" });
/**
 * US-0071 (A1b Task 5): `voiceChosen` is carried along and ignored by the worker. `generation` is present only when control runs with
 * SPEECH_INGEST=livekit: a frame is then attributed only to the generation whose track produced it (a file-ingest run never gets one).
 */
const Holder = z.strictObject({ roleId: RoleId, participantId: ParticipantId, recording: z.boolean(), voiceChosen: z.boolean().optional(), generation: GenerationSchema.optional() });
export type VoiceHolder = z.infer<typeof Holder>;
/** The seats as the runtime last reported them (`voice_seats`). Until the first one arrives the worker treats every track as not recording. */
const VoiceState = z.strictObject({ type: z.literal("voice_state"), paused: z.boolean(), ended: z.boolean(), holders: z.array(Holder).max(MAX_HOLDERS) });
/** The runtime's answer to one voice line: exactly one of `seq` (recorded) and `refused`. */
const VoiceLineResult = z
  .strictObject({ type: z.literal("voice_line_result"), segmentId: SegmentIdSchema, seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), refused: z.enum(VOICE_REFUSALS).optional() })
  .refine((m) => (m.seq === undefined) !== (m.refused === undefined), { message: "exactly one of seq and refused" });
/** US-0071: always the answer to a `livekit_token_request` for that role: the signalling URL, a fresh worker token and the seat's room. */
const LiveKitJoin = z.strictObject({
  type: z.literal("livekit_join"), roleId: RoleId, url: LiveKitUrl, token: z.string().min(1).max(MAX_LIVEKIT_TOKEN_CHARS), room: RoomName,
});
/**
 * US-0071 (A1b batch 3 review F1): control will not give a worker token for the seat now (paused, not recording, no seats yet, voice off,
 * or a minting failure). The worker's join fails at once, and the ingest joins again after a short backoff while the seat still records.
 */
const LiveKitJoinRefused = z.strictObject({ type: z.literal("livekit_join_refused"), roleId: RoleId });
/** US-0071: control grants a requested speech-to-text slot. */
const SttSlotGrant = z.strictObject({ type: z.literal("stt_slot_grant"), slot: SlotIdSchema });
export const ControlToWorkerSchema = z.discriminatedUnion("type", [VoiceState, VoiceLineResult, LiveKitJoin, LiveKitJoinRefused, SttSlotGrant]);
export type ControlToWorker = z.infer<typeof ControlToWorkerSchema>;

/**
 * US-0075 (EPIC-0003 voice A2b-1b): the `deleted` line of a role's `index.jsonl`. Control writes it (under the store lock) when the
 * facilitator deletes a segment's audio; speech's index reader skips it and the sweep treats the segment as no longer playable. The ONE
 * definition of the format, so no second parser exists. `op` is the 16-hex id of the delete request that wrote it.
 */
export type DeletedIndexLine = { v: 1; kind: "deleted"; segment: string; op: string; ts: number };

/** True when `x` is a well-formed `deleted` line: `v` 1, a file-safe segment, a 16 lower-case hex op, a finite non-negative `ts`. */
export const isDeletedLine = (x: unknown): x is DeletedIndexLine => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return o.v === 1 && o.kind === "deleted" && typeof o.segment === "string" && isFileSafeId(o.segment) && isLowerHex(o.op, 16)
    && typeof o.ts === "number" && Number.isFinite(o.ts) && o.ts >= 0;
};

/**
 * Appends `lines` to an EXISTING role index in ONE write and one fsync (O_APPEND, never through a link, no O_CREAT: a segment to delete
 * implies its index exists, and creating one could plant an index in the wrong folder). One descriptor throughout (never a second open by
 * path): it is judged on its `fstat` (a regular file of this user), a torn last line (no final newline) is terminated first, and a short
 * write is continued (`write` is a test seam; `writeFully` lives in speech's store, which this module must not import, so the loop is
 * inlined). Errors carry the errno code only, never the path.
 */
export function appendDeletedLines(file: string, lines: DeletedIndexLine[], write: (fd: number, buf: Buffer, off: number, len: number) => number = writeSync): void {
  let fd: number;
  try { fd = openSync(file, fc.O_RDWR | fc.O_APPEND | fc.O_NOFOLLOW); }
  catch (err) { throw codeError(`could not open the audio index (${(err as NodeJS.ErrnoException).code ?? "error"})`, (err as NodeJS.ErrnoException).code); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw codeError("the audio index is not a regular file", "not_regular");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw codeError("the audio index is not owned by this user", "not_owned");
    if (lines.length === 0) return;
    let prefix = "";
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, st.size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    const buf = Buffer.from(prefix + lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = write(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0) throw codeError("could not write the audio index (short_write)", "short_write");
      off += n;
    }
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof Error && typeof code === "string" && err.message.includes(`(${code})`)) throw err;
    if (err instanceof Error && ["not_regular", "not_owned"].includes(code ?? "")) throw err;
    throw codeError(`could not write the audio index (${code ?? "error"})`, code);
  } finally { closeSync(fd); }
}

/** An error whose message names no path; `code` is the errno code or a fixed word. */
const codeError = (message: string, code: string | undefined): Error => Object.assign(new Error(message), { code });
