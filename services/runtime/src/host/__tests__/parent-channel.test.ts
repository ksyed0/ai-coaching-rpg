import { describe, expect, it, vi } from "vitest";
import { ChildMessageSchema, ParentMessageSchema, openParentChannel, type ChildMessage } from "../parent-channel.js";

type Handler = (...a: unknown[]) => void;
const fakeProc = (over: { send?: unknown; connected?: boolean } = {}) => {
  const handlers = new Map<string, Handler[]>();
  const proc = {
    send: "send" in over ? over.send : vi.fn((_m: unknown, cb?: (e: Error | null) => void) => { cb?.(null); return true; }),
    connected: over.connected ?? true,
    on(ev: string, fn: Handler) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); return proc; },
  };
  const emit = (ev: string, ...a: unknown[]) => (handlers.get(ev) ?? []).forEach((h) => h(...a));
  return { proc: proc as never, raw: proc, emit };
};

describe("parent channel", () => {
  it("returns null without an IPC channel", () => {
    expect(openParentChannel(fakeProc({ send: undefined }).proc)).toBeNull();
  });

  it("send returns false when process.send throws, returns false, or the channel is disconnected", () => {
    const ok = fakeProc();
    const ch = openParentChannel(ok.proc)!;
    expect(ch.send({ type: "ended" })).toBe(true);
    expect((ok.raw.send as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBeTypeOf("function");

    expect(openParentChannel(fakeProc({ send: () => { throw new Error("boom"); } }).proc)!.send({ type: "ended" })).toBe(false);
    expect(openParentChannel(fakeProc({ send: () => false }).proc)!.send({ type: "ended" })).toBe(false);
    const down = fakeProc({ connected: false });
    expect(openParentChannel(down.proc)!.send({ type: "ended" })).toBe(false);
    expect((down.raw.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("swallows an asynchronous send failure", () => {
    const f = fakeProc({ send: (_m: unknown, cb?: (e: Error | null) => void) => { cb?.(new Error("EPIPE")); return true; } });
    expect(() => openParentChannel(f.proc)!.send({ type: "ended" })).not.toThrow();
  });

  it("onMessage ignores anything that is not a valid ParentMessage (wrong type, extra shapes, non-object)", () => {
    const f = fakeProc();
    const got: unknown[] = [];
    openParentChannel(f.proc)!.onMessage((m) => got.push(m));
    const valid = { type: "reissue", requestId: "req_1-A", roleId: "analyst", by: "Ann" };
    for (const bad of [
      null, undefined, "reissue", 7, [], {}, { type: "nope" },
      { ...valid, extra: 1 }, { ...valid, requestId: "" }, { ...valid, requestId: "a".repeat(65) }, { ...valid, requestId: "a b" },
      { ...valid, roleId: "facilitator" }, { ...valid, roleId: "__proto__" }, { ...valid, roleId: "Bad Id" }, { ...valid, roleId: "a".repeat(129) },
      { ...valid, by: "x".repeat(201) }, { ...valid, by: 5 },
    ]) f.emit("message", bad);
    expect(got).toEqual([]);
    f.emit("message", valid);
    f.emit("message", { type: "reissue", requestId: "r2", roleId: "cfo" });
    expect(got).toEqual([valid, { type: "reissue", requestId: "r2", roleId: "cfo" }]);
  });

  it('onDisconnect fires once on "disconnect"', () => {
    const f = fakeProc();
    const fn = vi.fn();
    openParentChannel(f.proc)!.onDisconnect(fn);
    f.emit("disconnect");
    f.emit("disconnect");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("every ChildMessage variant round-trips; empty codes accepted; unknown keys rejected", () => {
    const variants: ChildMessage[] = [
      { type: "codes", codes: [{ roleId: "analyst", code: "ABC" }] },
      { type: "codes", codes: [] },
      { type: "ready", port: 4000, logIdentity: "id", status: "new", modelLabel: "Mock" },
      { type: "ready", port: 4000, status: "resumed", modelLabel: "Mock" },
      { type: "ended" },
      { type: "reissued", requestId: "r1", code: "XYZ" },
      { type: "reissue_failed", requestId: "r1", reason: "no such role" },
      { type: "ai_roles_set", requestId: "r1", codes: [{ roleId: "tech_lead", code: "XYZ" }] },
      { type: "ai_roles_set", requestId: "r1", codes: [] },
      { type: "ai_roles_failed", requestId: "r1", reason: "the AI roles could not be changed" },
      { type: "ready", port: 4000, status: "resumed", modelLabel: "Mock", aiRoles: ["tech_lead"] },
    ];
    for (const v of variants) expect(ChildMessageSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(ChildMessageSchema.safeParse({ type: "ended", extra: 1 }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "codes", codes: [{ roleId: "a", code: "b", x: 1 }] }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "reissued", requestId: "r", code: "c".repeat(65) }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "reissue_failed", requestId: "r", reason: "r".repeat(201) }).success).toBe(false);
  });

  it("ready, codes and their fields are bounded (the parent validates with the same schema)", () => {
    const ready = { type: "ready", port: 4000, status: "new", modelLabel: "Mock" };
    const ok = (m: unknown) => ChildMessageSchema.safeParse(m).success;
    expect(ok(ready)).toBe(true);
    expect(ok({ ...ready, logIdentity: "x".repeat(200) })).toBe(true);
    expect(ok({ ...ready, logIdentity: "x".repeat(201) })).toBe(false);
    expect(ok({ ...ready, modelLabel: "" })).toBe(false);
    expect(ok({ ...ready, modelLabel: "m".repeat(201) })).toBe(false);
    expect(ok({ ...ready, port: 0 })).toBe(false);
    expect(ok({ ...ready, port: 65536 })).toBe(false);
    expect(ok({ ...ready, port: 1.5 })).toBe(false);
    const entry = (i: number) => ({ roleId: `r${i}`, code: "c" });
    expect(ok({ type: "codes", codes: Array.from({ length: 256 }, (_, i) => entry(i)) })).toBe(true);
    expect(ok({ type: "codes", codes: Array.from({ length: 257 }, (_, i) => entry(i)) })).toBe(false);
    expect(ok({ type: "codes", codes: [{ roleId: "facilitator", code: "c" }] })).toBe(false);
    expect(ok({ type: "codes", codes: [{ roleId: "Bad Id", code: "c" }] })).toBe(false);
    expect(ok({ type: "codes", codes: [{ roleId: "a", code: "c".repeat(65) }] })).toBe(false);
  });

  it("set_ai_roles with an extra key, a reserved role id, 257 roles or roles as a string is dropped", () => {
    const f = fakeProc();
    const got: unknown[] = [];
    openParentChannel(f.proc)!.onMessage((m) => got.push(m));
    const valid = { type: "set_ai_roles", requestId: "r1", roles: ["tech_lead"] };
    for (const bad of [
      { ...valid, extra: 1 }, { ...valid, by: "Kim" }, { ...valid, includeInGroup: "x" }, { ...valid, includeInGroup: 0 }, { ...valid, includeInGroup: null }, { ...valid, roles: ["facilitator"] }, { ...valid, roles: ["Bad Id"] },
      { ...valid, roles: Array.from({ length: 257 }, (_, i) => `r${i}`) }, { ...valid, roles: "tech_lead" }, { ...valid, roles: [7] }, { ...valid, requestId: "a b" }, { type: "set_ai_roles", roles: [] },
    ]) f.emit("message", bad);
    expect(got).toEqual([]);
    f.emit("message", valid);
    f.emit("message", { type: "set_ai_roles", requestId: "r2", roles: [] });
    f.emit("message", { type: "set_ai_roles", requestId: "r3", roles: Array.from({ length: 256 }, (_, i) => `r${i}`) });
    expect(got).toHaveLength(3);
    // US-0061: the option is a boolean and optional.
    f.emit("message", { ...valid, requestId: "r4", includeInGroup: true });
    f.emit("message", { ...valid, requestId: "r5", includeInGroup: false });
    expect(got).toHaveLength(5);
    expect(ParentMessageSchema.safeParse({ type: "reissue", requestId: "r1", roleId: "cfo" }).success).toBe(true);
  });

  it("ready carries includeInGroup / includeInGroupReset only as false", () => {
    const base = { type: "ready", port: 4000, status: "new", modelLabel: "m" };
    for (const k of ["includeInGroup", "includeInGroupReset"]) {
      expect(ChildMessageSchema.safeParse({ ...base, [k]: false }).success, k).toBe(true);
      for (const bad of [true, "false", 0, null]) expect(ChildMessageSchema.safeParse({ ...base, [k]: bad }).success, `${k}=${String(bad)}`).toBe(false);
    }
    expect(ChildMessageSchema.safeParse(base).success).toBe(true);
  });

  it("bot_alert with an extra key, a reserved role id or a 201-character message is dropped", () => {
    const f = fakeProc();
    const got: unknown[] = [];
    openParentChannel(f.proc)!.onMessage((m) => got.push(m));
    const valid = { type: "bot_alert", roleId: "tech_lead", message: "skipped a turn: the model did not answer" };
    for (const bad of [
      { ...valid, extra: 1 }, { ...valid, requestId: "r1" }, { ...valid, roleId: "facilitator" }, { ...valid, roleId: "Bad Id" }, { ...valid, message: "x".repeat(201) },
      { ...valid, message: "" }, { ...valid, message: 7 }, { type: "bot_alert", message: "m" }, { type: "bot_alert", roleId: "tech_lead" },
    ]) f.emit("message", bad);
    expect(got).toEqual([]);
    f.emit("message", valid);
    f.emit("message", { ...valid, message: "x".repeat(200) });
    expect(got).toHaveLength(2);
  });

  it("ready.aiCalls is an integer from 1 to 1000000", () => {
    const ok = (m: unknown) => ChildMessageSchema.safeParse(m).success;
    const ready = { type: "ready", port: 4000, status: "resumed", modelLabel: "Mock" };
    expect(ok({ ...ready, aiCalls: 1 })).toBe(true);
    expect(ok({ ...ready, aiCalls: 1_000_000 })).toBe(true);
    for (const bad of [0, -1, 1.5, 1_000_001, "3", null]) expect(ok({ ...ready, aiCalls: bad })).toBe(false);
  });

  it("ai_roles_set, ai_roles_failed and ready.aiRoles are bounded", () => {
    const ok = (m: unknown) => ChildMessageSchema.safeParse(m).success;
    const entry = (i: number) => ({ roleId: `r${i}`, code: "c" });
    expect(ok({ type: "ai_roles_set", requestId: "r", codes: Array.from({ length: 256 }, (_, i) => entry(i)) })).toBe(true);
    expect(ok({ type: "ai_roles_set", requestId: "r", codes: Array.from({ length: 257 }, (_, i) => entry(i)) })).toBe(false);
    expect(ok({ type: "ai_roles_set", requestId: "r", codes: [{ roleId: "facilitator", code: "c" }] })).toBe(false);
    expect(ok({ type: "ai_roles_set", requestId: "../x", codes: [] })).toBe(false);
    expect(ok({ type: "ai_roles_failed", requestId: "r", reason: "r".repeat(200) })).toBe(true);
    expect(ok({ type: "ai_roles_failed", requestId: "r", reason: "r".repeat(201) })).toBe(false);
    const ready = { type: "ready", port: 4000, status: "new", modelLabel: "Mock" };
    expect(ok({ ...ready, aiRoles: Array.from({ length: 256 }, (_, i) => `r${i}`) })).toBe(true);
    expect(ok({ ...ready, aiRoles: Array.from({ length: 257 }, (_, i) => `r${i}`) })).toBe(false);
    expect(ok({ ...ready, aiRoles: ["facilitator"] })).toBe(false);
    expect(ok({ ...ready, aiRoles: "tech_lead" })).toBe(false);
  });
});

describe("parent channel and voice (US-0070)", () => {
  it("an older runtime drops a parent message it does not know without throwing or answering (F3)", () => {
    const f = fakeProc();
    const got: unknown[] = [];
    openParentChannel(f.proc)!.onMessage((m) => got.push(m));
    expect(() => f.emit("message", { type: "voice_future", segmentId: "abc", text: "hello" })).not.toThrow();
    expect(got).toEqual([]);
    expect(f.raw.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("the voice parent messages are delivered when well formed", () => {
    const f = fakeProc();
    const got: unknown[] = [];
    openParentChannel(f.proc)!.onMessage((m) => got.push(m));
    const msgs = [
      { type: "voice_line", segmentId: "0123456789abcdef", roleId: "tech_lead", participantId: "p-1", text: "We ship in May." },
      { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 500 },
      { type: "voice_notice", roleId: "tech_lead", participantId: "p-1", code: "empty" },
      { type: "voice_alert", code: "worker_down" },
    ];
    for (const m of msgs) f.emit("message", m);
    expect(got).toEqual(msgs);
  });

  it("every voice ChildMessage variant round-trips", () => {
    const variants: ChildMessage[] = [
      { type: "ready", port: 4000, status: "new", modelLabel: "Mock", voice: true },
      { type: "voice_line_ack", segmentId: "abc", seq: 7 },
      { type: "voice_line_refused", segmentId: "abc", code: "not_holder" },
      { type: "voice_seats", paused: false, ended: false, holders: [{ roleId: "cfo", participantId: "p", recording: true }] },
      { type: "voice_turn", open: true },
      { type: "voice_choice", roleId: "cfo", participantId: "p", choice: "text_only", at: 5 },
    ];
    for (const v of variants) expect(ChildMessageSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
});
