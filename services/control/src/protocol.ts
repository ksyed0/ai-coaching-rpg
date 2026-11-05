import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isReservedRoleId, isSafeId, isScenarioId } from "@acr/events";

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
export const ParentMessageSchema = z.discriminatedUnion("type", [ReissueSchema, SetAiRolesSchema, BotAlertSchema]);
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
  }),
  z.strictObject({ type: z.literal("ended") }),
  z.strictObject({ type: z.literal("reissued"), requestId: RequestId, code: z.string().min(1).max(MAX_CODE_CHARS) }),
  z.strictObject({ type: z.literal("reissue_failed"), requestId: RequestId, reason: z.string().max(MAX_REASON_CHARS) }),
  z.strictObject({ type: z.literal("ai_roles_set"), requestId: RequestId, codes: z.array(z.strictObject({ roleId: RoleId, code: z.string().min(1).max(MAX_CODE_CHARS) })).max(MAX_CODES) }),
  z.strictObject({ type: z.literal("ai_roles_failed"), requestId: RequestId, reason: z.string().max(MAX_REASON_CHARS) }),
]);
export type ChildMessage = z.infer<typeof ChildMessageSchema>;
