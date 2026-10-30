import { describe, expect, it, vi } from "vitest";
import { ChildMessageSchema, openParentChannel, type ChildMessage } from "../parent-channel.js";

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
    ];
    for (const v of variants) expect(ChildMessageSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(ChildMessageSchema.safeParse({ type: "ended", extra: 1 }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "codes", codes: [{ roleId: "a", code: "b", x: 1 }] }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "reissued", requestId: "r", code: "c".repeat(65) }).success).toBe(false);
    expect(ChildMessageSchema.safeParse({ type: "reissue_failed", requestId: "r", reason: "r".repeat(201) }).success).toBe(false);
  });
});
