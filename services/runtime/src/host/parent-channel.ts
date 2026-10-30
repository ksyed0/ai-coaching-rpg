import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, isReservedRoleId, isSafeId, isScenarioId } from "@acr/events";

/**
 * US-0058: the runtime's typed side of the fork() IPC channel to the control service. Both directions are strict zod schemas
 * (unknown keys refused) and the types are inferred from them so they cannot drift.
 */

/** A request id the control service makes up: 1 to 64 letters, digits, `_` or `-`. */
const RequestId = z.string().refine(isSafeId, { message: "invalid request id" });
/** A role id: the repo's scenario-id rule (lowercase letters, digits, `_`, `-`), at most CLIENT_ID_MAX_CHARS, never a reserved word. */
const RoleId = z.string().min(1).max(CLIENT_ID_MAX_CHARS).refine((v) => isScenarioId(v) && !isReservedRoleId(v), { message: "invalid role id" });
const MAX_CODE_CHARS = 64;
const MAX_REASON_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_CODES = 256;
/** Raw bound only; the runtime cleans the name later. */
const MAX_BY_CHARS = 200;

export const ParentMessageSchema = z.strictObject({
  type: z.literal("reissue"),
  requestId: RequestId,
  roleId: RoleId,
  by: z.string().max(MAX_BY_CHARS).optional(),
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

export interface ParentChannel {
  /** True when the message was handed to the channel; false when it threw, returned false or the channel is disconnected. Never throws. */
  send(msg: ChildMessage): boolean;
  /** Valid ParentMessages only; anything else is dropped without a throw or a log. */
  onMessage(fn: (m: ParentMessage) => void): void;
  /** Fires once when the parent goes away. */
  onDisconnect(fn: () => void): void;
}

/** The channel to the parent, or null when this process was not forked with IPC (the terminal). */
export function openParentChannel(proc: Pick<NodeJS.Process, "send" | "on" | "connected"> = process): ParentChannel | null {
  if (typeof proc.send !== "function") return null;
  const send = proc.send.bind(proc);
  return {
    send(msg) {
      if (!proc.connected) return false;
      try {
        // The callback swallows an asynchronous failure (EPIPE after the parent left): it must not become an unhandled error.
        return send(msg, () => {}) !== false;
      } catch {
        return false;
      }
    },
    onMessage(fn) {
      proc.on("message", (raw: unknown) => {
        const parsed = ParentMessageSchema.safeParse(raw);
        if (parsed.success) fn(parsed.data);
      });
    },
    onDisconnect(fn) {
      let fired = false;
      proc.on("disconnect", () => { if (fired) return; fired = true; fn(); });
    },
  };
}
