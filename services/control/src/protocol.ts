import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isReservedRoleId, isSafeId, isScenarioId } from "@acr/events";

/**
 * The control service's OWN copy of the fork() IPC messages (it must not import the runtime). Strict zod schemas: every message the
 * control service receives from a child is validated here. `protocol.drift.test.ts` fails if this copy differs from the runtime's.
 */
const RequestId = z.string().refine(isSafeId, { message: "invalid request id" });
const RoleId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => isScenarioId(v) && !isReservedRoleId(v), { message: "invalid role id" });
const MAX_CODE_CHARS = 64;
const MAX_REASON_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_CODES = 256;
const MAX_BY_CHARS = 200;

export const ParentMessageSchema = z.strictObject({
  type: z.literal("reissue"),
  requestId: RequestId,
  roleId: RoleId,
  by: z.string().max(MAX_BY_CHARS).optional(),
  /** US-0059: a remove (before the start only) instead of a plain reissue. */
  reason: z.literal("removed").optional(),
});
export type ParentMessage = z.infer<typeof ParentMessageSchema>;

export const ChildMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("codes"), codes: z.array(z.strictObject({ roleId: RoleId, code: z.string().min(1).max(MAX_CODE_CHARS) })).max(MAX_CODES) }),
  z.strictObject({
    type: z.literal("ready"), port: z.number().int().min(1).max(65535), logIdentity: z.string().max(MAX_LABEL_CHARS).optional(),
    status: z.enum(["new", "resumed"]), modelLabel: z.string().min(1).max(MAX_LABEL_CHARS),
  }),
  z.strictObject({ type: z.literal("ended") }),
  z.strictObject({ type: z.literal("reissued"), requestId: RequestId, code: z.string().min(1).max(MAX_CODE_CHARS) }),
  z.strictObject({ type: z.literal("reissue_failed"), requestId: RequestId, reason: z.string().max(MAX_REASON_CHARS) }),
]);
export type ChildMessage = z.infer<typeof ChildMessageSchema>;
