import { describe, expect, it } from "vitest";
import { ClientMessageSchema } from "../protocol.js";

const msg = (command: unknown) => ClientMessageSchema.safeParse({ type: "command", command });

describe("mute_seat in the client protocol (A3A)", () => {
  it("accepts exactly roleId and a boolean muted", () => {
    expect(msg({ command: "mute_seat", roleId: "host", muted: true }).success).toBe(true);
    expect(msg({ command: "mute_seat", roleId: "host", muted: false }).success).toBe(true);
  });
  it("refuses an extra key (free text), a missing roleId, a missing or non-boolean muted, and an empty roleId", () => {
    expect(msg({ command: "mute_seat", roleId: "host", muted: true, reason: "noisy" }).success).toBe(false);
    expect(msg({ command: "mute_seat", muted: true }).success).toBe(false);
    expect(msg({ command: "mute_seat", roleId: "host" }).success).toBe(false);
    expect(msg({ command: "mute_seat", roleId: "host", muted: "true" }).success).toBe(false);
    expect(msg({ command: "mute_seat", roleId: "", muted: true }).success).toBe(false);
  });
  it("does not accept the participant's command name", () => {
    expect(msg({ command: "mute_voice", roleId: "host", muted: true }).success).toBe(false);
  });
});
