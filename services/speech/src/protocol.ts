import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isFileSafeId, isReservedRoleId, isScenarioId } from "@acr/events";

/**
 * US-0070 (EPIC-0003 voice A1a): the speech worker's fork() IPC messages to and from the control service. The ONE source of these
 * schemas: control imports this module as `@acr/speech/protocol` and nothing else of `@acr/speech` (a control import test pins it), so no
 * native audio code ever loads into control. This module imports only zod and @acr/events. Every schema is strict (unknown keys refused).
 *
 * The worker never talks to the runtime: control relays a `voice_line` to the runtime over the parent channel and gives the answer back
 * as `voice_line_result`. See docs/superpowers/plans/2026-11-08-voice-part-a-overview.md, "Cross-slice interfaces", section 1.
 */

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
export const WorkerMessageSchema = z.discriminatedUnion("type", [WorkerReady, VoiceLine, SpeechActivity, SegmentFailed]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

const Holder = z.strictObject({ roleId: RoleId, participantId: ParticipantId, recording: z.boolean() });
export type VoiceHolder = z.infer<typeof Holder>;
/** The seats as the runtime last reported them (`voice_seats`). Until the first one arrives the worker treats every track as not recording. */
const VoiceState = z.strictObject({ type: z.literal("voice_state"), paused: z.boolean(), ended: z.boolean(), holders: z.array(Holder).max(MAX_HOLDERS) });
/** The runtime's answer to one voice line: exactly one of `seq` (recorded) and `refused`. */
const VoiceLineResult = z
  .strictObject({ type: z.literal("voice_line_result"), segmentId: SegmentIdSchema, seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), refused: z.enum(VOICE_REFUSALS).optional() })
  .refine((m) => (m.seq === undefined) !== (m.refused === undefined), { message: "exactly one of seq and refused" });
export const ControlToWorkerSchema = z.discriminatedUnion("type", [VoiceState, VoiceLineResult]);
export type ControlToWorker = z.infer<typeof ControlToWorkerSchema>;
