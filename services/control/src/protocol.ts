import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isFileSafeId, isReservedRoleId, isSafeId, isScenarioId } from "@acr/events";

/**
 * The control service's OWN copy of the fork() IPC messages (it must not import the runtime). Strict zod schemas: every message the
 * control service receives from a child is validated here. `protocol.drift.test.ts` fails if this copy differs from the runtime's.
 */
const RequestId = z.string().refine(isSafeId, { message: "invalid request id" });
const RoleId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => isScenarioId(v) && !isReservedRoleId(v), { message: "invalid role id" });
/** US-0060: the role-id rule, shared with the bot code (a bot alert names a role). */
export const RoleIdSchema = RoleId;
const MAX_CODE_CHARS = 64;
const MAX_REASON_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_CODES = 256;
const MAX_BY_CHARS = 200;
const MAX_BOT_ALERT_CHARS = 200;
const MAX_AI_CALLS = 1_000_000;
/** The runtime's REBIND_PENDING (engine/consent.ts): a seat released by a reissue after the start; never a participant id. Pinned by the drift test. */
const REBIND_PENDING = "rebind-pending";

const ReissueSchema = z.strictObject({
  type: z.literal("reissue"),
  requestId: RequestId,
  roleId: RoleId,
  by: z.string().max(MAX_BY_CHARS).optional(),
  /** US-0059: a remove (before the start only) instead of a plain reissue. */
  reason: z.literal("removed").optional(),
});
/** US-0060: which player roles an AI plays (before the start). No `by`. `includeInGroup` absent keeps the current option (US-0061). */
const SetAiRolesSchema = z.strictObject({ type: z.literal("set_ai_roles"), requestId: RequestId, roles: z.array(RoleId).max(MAX_CODES), includeInGroup: z.boolean().optional() });
/** US-0060: a live AI player's alert for the facilitator. Fire-and-forget: the runtime never answers it. */
const BotAlertSchema = z.strictObject({ type: z.literal("bot_alert"), roleId: RoleId, message: z.string().min(1).max(MAX_BOT_ALERT_CHARS) });

/**
 * US-0070 (EPIC-0003 voice A1a): the voice messages (overview section 2). The correlation id of a voice line is its `segmentId` (a
 * file-safe id the speech worker makes up); the runtime answers every `voice_line` exactly once, with `voice_line_ack` or
 * `voice_line_refused`. `speech_activity`, `voice_notice` and `voice_alert` are fire-and-forget. Control sends voice messages only to a
 * runtime whose `ready` carried `voice: true`.
 */
export const VOICE_REFUSALS = ["voice_off", "not_started", "unknown_role", "ai_role", "not_holder", "not_recording", "paused", "not_in_scene", "ended", "failed"] as const;
export type VoiceRefusal = (typeof VOICE_REFUSALS)[number];
/** US-0071 adds `worker_restarting`, `voice_off` and `stt_recovered` (the last one an info alert). */
export const VOICE_ALERT_CODES = ["worker_down", "stt_unavailable", "stt_failed", "worker_restarting", "voice_off", "stt_recovered"] as const;
export type VoiceAlertCode = (typeof VOICE_ALERT_CODES)[number];
const MAX_VOICE_TEXT_CHARS = 2000;
const MAX_SILENT_MS = 60_000;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;
const SegmentId = z.string().refine(isFileSafeId, { message: "invalid segment id" });
const ParticipantId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => v !== REBIND_PENDING, { message: "invalid participant id" });
const VoiceLineSchema = z.strictObject({ type: z.literal("voice_line"), segmentId: SegmentId, roleId: RoleId, participantId: ParticipantId, text: z.string().min(1).max(MAX_VOICE_TEXT_CHARS) });
/** `silentMs` (milliseconds since the track's last speech frame) only with `active: false`. */
const SpeechActivitySchema = z
  .strictObject({ type: z.literal("speech_activity"), roleId: RoleId, active: z.boolean(), silentMs: z.number().int().min(0).max(MAX_SILENT_MS).optional() })
  .refine((m) => !(m.active && m.silentMs !== undefined), { message: "silentMs only with active: false" });
/** Only the worker's own outcomes come from control; the runtime's refusals become notices inside the runtime. */
const VoiceNoticeSchema = z.strictObject({ type: z.literal("voice_notice"), roleId: RoleId, participantId: ParticipantId, code: z.enum(["stt_failed", "empty"]) });
const VoiceAlertSchema = z.strictObject({ type: z.literal("voice_alert"), code: z.enum(VOICE_ALERT_CODES) });
/**
 * US-0071: whether voice input can work for this session (`available`: the speech worker and the speech-to-text server are up) and
 * whether it is off for good after repeated faults (`off`). Control sends it on every change and on every runtime `ready`.
 * Fire-and-forget: never answered. The runtime applies it before anything else, with no rate limit.
 */
const VoiceAvailabilitySchema = z.strictObject({ type: z.literal("voice_availability"), available: z.boolean(), off: z.boolean() });
const VoiceHolderSchema = z.strictObject({ roleId: RoleId, participantId: ParticipantId, recording: z.boolean() });
const VoiceLineAckSchema = z.strictObject({ type: z.literal("voice_line_ack"), segmentId: SegmentId, seq: z.number().int().min(1).max(MAX_SEQ) });
const VoiceLineRefusedSchema = z.strictObject({ type: z.literal("voice_line_refused"), segmentId: SegmentId, code: z.enum(VOICE_REFUSALS) });
const VoiceSeatsSchema = z.strictObject({ type: z.literal("voice_seats"), paused: z.boolean(), ended: z.boolean(), holders: z.array(VoiceHolderSchema).max(MAX_CODES) });
const VoiceTurnSchema = z.strictObject({ type: z.literal("voice_turn"), open: z.boolean() });
const VoiceChoiceSchema = z.strictObject({ type: z.literal("voice_choice"), roleId: RoleId, participantId: ParticipantId, choice: z.enum(["voice", "text_only"]), at: z.number().int().min(0).max(MAX_SEQ) });
export const ParentMessageSchema = z.discriminatedUnion("type", [ReissueSchema, SetAiRolesSchema, BotAlertSchema, VoiceLineSchema, SpeechActivitySchema, VoiceNoticeSchema, VoiceAlertSchema, VoiceAvailabilitySchema]);
export type ParentMessage = z.infer<typeof ParentMessageSchema>;

export const ChildMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("codes"), codes: z.array(z.strictObject({ roleId: RoleId, code: z.string().min(1).max(MAX_CODE_CHARS) })).max(MAX_CODES) }),
  z.strictObject({
    type: z.literal("ready"), port: z.number().int().min(1).max(65535), logIdentity: z.string().max(MAX_LABEL_CHARS).optional(),
    status: z.enum(["new", "resumed"]), modelLabel: z.string().min(1).max(MAX_LABEL_CHARS),
    /** US-0060: the AI roles, present only when there are any. */
    aiRoles: z.array(RoleId).max(MAX_CODES).optional(),
    /** BUG-0021: the lobby's AI roles this start dropped with the old seats (fresh codes); present only when there were any. The parent restores them. */
    aiRolesReset: z.array(RoleId).max(MAX_CODES).optional(),
    /** US-0061: the group-score option; present only when it is off (`false`). */
    includeInGroup: z.literal(false).optional(),
    /** US-0061: the option the dropped lobby seats had; present only as `false`, with aiRolesReset. */
    includeInGroupReset: z.literal(false).optional(),
    /** US-0060: the AI-player model calls already recorded in the log (utterances of AI roles); present only when above 0. */
    aiCalls: z.number().int().min(1).max(MAX_AI_CALLS).optional(),
    /** US-0070: present only when VOICE_ENABLED=1 was accepted at bootstrap (an older control would refuse the key, so it is never sent otherwise). */
    voice: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("ended") }),
  z.strictObject({ type: z.literal("reissued"), requestId: RequestId, code: z.string().min(1).max(MAX_CODE_CHARS) }),
  z.strictObject({ type: z.literal("reissue_failed"), requestId: RequestId, reason: z.string().max(MAX_REASON_CHARS) }),
  z.strictObject({ type: z.literal("ai_roles_set"), requestId: RequestId, codes: z.array(z.strictObject({ roleId: RoleId, code: z.string().min(1).max(MAX_CODE_CHARS) })).max(MAX_CODES) }),
  z.strictObject({ type: z.literal("ai_roles_failed"), requestId: RequestId, reason: z.string().max(MAX_REASON_CHARS) }),
  VoiceLineAckSchema, VoiceLineRefusedSchema, VoiceSeatsSchema, VoiceTurnSchema, VoiceChoiceSchema,
]);
export type ChildMessage = z.infer<typeof ChildMessageSchema>;
