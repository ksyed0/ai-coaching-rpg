import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotHost } from "../bots/bot-host.js";
import type { ControlConfig } from "../config.js";
import { SessionList } from "../session-list.js";
import { Supervisor, type BotDeps, type SetTimer, type SpawnFn } from "../supervisor.js";
import { AI_CONFIG, CODES, FakeChild, READY, flush, sid } from "./fake-child.js";

type Call = { op: string; id: string; arg?: unknown };
let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, calls: Call[], logs: string[];
let attachImpl: (id: string, o: { port: number; aiRoles: string[]; aiCalls?: number }) => Promise<void>;
type T = { fn: () => void; ms: number; cancelled: boolean };
let timers: T[];
let deps: BotDeps;
let closeImpl: () => Promise<void>;
const setTimer: SetTimer = (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await flush(); };
/** A recording stand-in for the BotHost: only the methods the supervisor uses. */
const fakeBots = (): BotHost => ({
  attach: (id: string, o: { port: number; aiRoles: string[]; aiCalls?: number }) => { calls.push({ op: "attach", id, arg: o }); return attachImpl(id, o); },
  end: async (id: string) => { calls.push({ op: "end", id }); },
  detach: async (id: string) => { calls.push({ op: "detach", id }); },
  close: () => { calls.push({ op: "close", id: "" }); return closeImpl(); },
} as unknown as BotHost);
const make = (withBots = true) => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
  ...(withBots ? { bots: (d: BotDeps) => { deps = d; return fakeBots(); } } : {}),
});
const boot = async (sup: Supervisor, ready: Record<string, unknown> = READY): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other");
  await settle();
  const c = children[children.length - 1]!;
  c.emit({ type: "codes", codes: CODES }); c.emit(ready);
  const r = await p;
  return { id: r.sessionId, c };
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-bots-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 777, readyTimeoutMs: 5000,
    ...AI_CONFIG,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; calls = []; logs = []; timers = []; closeImpl = async () => {};
  attachImpl = async () => {};
  spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); writeFileSync(logFile, "log"); children.push(c); return c; };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Supervisor and the BotHost", () => {
  it("a ready with aiRoles [tech_lead] and aiCalls 4 attaches the bots with port, roles and calls", async () => {
    const sup = make();
    const { id } = await boot(sup, { ...READY, aiRoles: ["tech_lead"], aiCalls: 4 });
    expect(calls).toEqual([{ op: "attach", id, arg: { port: 4321, aiRoles: ["tech_lead"], aiCalls: 4 } }]);
  });

  it("a ready without aiRoles attaches with []", async () => {
    const sup = make();
    const { id } = await boot(sup);
    expect(calls).toEqual([{ op: "attach", id, arg: { port: 4321, aiRoles: [], aiCalls: undefined } }]);
  });

  it("goLive returns before a BotHost.attach that never resolves, and survives one that throws", async () => {
    attachImpl = () => new Promise<void>(() => {});
    const sup = make();
    const r = await boot(sup); // would hang if attach were awaited
    expect(sup.get(r.id)!.status).toBe("running");
    attachImpl = () => { throw new TypeError("boom"); };
    const r2 = await boot(sup);
    expect(sup.get(r2.id)!.status).toBe("running");
    expect(logs.filter((l) => l.includes("TypeError"))).toHaveLength(1);
    attachImpl = () => Promise.reject(new RangeError("late"));
    const r3 = await boot(sup);
    await settle();
    expect(sup.get(r3.id)!.status).toBe("running");
    expect(logs.filter((l) => l.includes("RangeError"))).toHaveLength(1);
  });

  it("an ended before ready calls end and never attach; a child exit before goLive calls detach and never attach", async () => {
    const sup = make();
    const p = sup.create("other"); await settle();
    const c = children[0]!;
    c.emit({ type: "codes", codes: CODES }); c.emit(READY); c.emit({ type: "ended" });
    const r = await p;
    expect(calls).toEqual([{ op: "end", id: r.sessionId }]);
    calls.length = 0;
    const p2 = sup.create("other"); await settle();
    const c2 = children[1]!;
    c2.emit({ type: "codes", codes: CODES }); c2.emit(READY); c2.exit(1);
    const r2 = await p2;
    expect(calls).toEqual([{ op: "detach", id: r2.sessionId }]);
  });

  it("after shutdown a late goLive attaches nothing", async () => {
    const sup = make();
    await sup.shutdown();
    calls.length = 0;
    await boot(sup);
    expect(calls).toEqual([]);
  });

  it("the deps' reissue waits for the session lock: it is sent only after a pending setAiRoles releases it", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const set = sup.setAiRoles(id, ["cfo"]); await settle();
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
    const rp = deps.reissue(id, "cfo"); await settle();
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]); // queued behind the lock
    c.emit({ type: "ai_roles_set", requestId: c.sent[0]!.requestId, codes: [] });
    await set; await settle();
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles", "reissue"]);
    c.emit({ type: "reissued", requestId: c.sent[1]!.requestId, code: "X-CODE" });
    await expect(rp).resolves.toBe("X-CODE");
    sup.botAlert(id, "cfo", "hi");
    deps.alert(id, "cfo", "via deps");
    expect(c.alerts.map((a) => a.message)).toEqual(["hi", "via deps"]);
  });

  it("a bots.close() that never resolves is cut off after 3 s and the children are still disconnected", async () => {
    closeImpl = () => new Promise<void>(() => {});
    const sup = make();
    const { c } = await boot(sup);
    c.disconnect = () => { c.disconnected++; setImmediate(() => c.exit(0)); };
    const done = sup.shutdown(); await settle();
    expect(c.disconnected).toBe(0);
    const t = timers.find((x) => x.ms === 3000 && !x.cancelled)!;
    t.fn();
    await done;
    expect(c.disconnected).toBe(1);
    expect(logs.join("\n")).toContain("bots did not close in time");
  });

  it("ended calls end; a child exit calls detach and a restart attaches again with the new port", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    calls.length = 0;
    c.exit(1); await settle();
    expect(calls).toEqual([{ op: "detach", id }]);
    const p = sup.restart(id); await settle();
    children[1]!.emit({ type: "ready", port: 6002, status: "resumed", modelLabel: "m", aiRoles: ["cfo"] });
    await p;
    expect(calls.map((x) => x.op)).toEqual(["detach", "attach"]);
    expect(calls[1]).toEqual({ op: "attach", id, arg: { port: 6002, aiRoles: ["cfo"], aiCalls: undefined } });
    calls.length = 0;
    children[1]!.emit({ type: "ended" }); await settle();
    expect(calls).toEqual([{ op: "end", id }]);
  });

  it("after a control-service restart resumeAll resolves, then the reissue dep sends one reissue and the code never reaches a log line", async () => {
    list.upsert({ sessionId: sid(1), scenarioId: "other", status: "running" });
    const sup = make();
    let reissued: Promise<string> | undefined;
    // The host's chain calls the dep without awaiting it, from inside attach (which runs while resumeAll holds the lock).
    attachImpl = async (id) => { reissued = deps.reissue(id, "tech_lead"); };
    const p = sup.resumeAll(); await settle();
    children[0]!.emit({ ...READY, status: "resumed", aiRoles: ["tech_lead"] });
    await p; // no deadlock: resumeAll's lock is released although a reissue is queued behind it
    await settle();
    const c = children[0]!;
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ type: "reissue", roleId: "tech_lead" });
    expect(c.sent[0]).not.toHaveProperty("by");
    c.emit({ type: "reissued", requestId: c.sent[0]!.requestId, code: "SECRET-AI-CODE" });
    await expect(reissued).resolves.toBe("SECRET-AI-CODE");
    expect(logs.join("\n")).not.toContain("SECRET-AI-CODE");
  });

  it("botAlert sends bot_alert to the live child and nothing when stopped", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    sup.botAlert(id, "tech_lead", "out of budget");
    expect(c.alerts).toEqual([{ type: "bot_alert", roleId: "tech_lead", message: "out of budget" }]);
    sup.botAlert(id, "BAD ROLE", "x");
    sup.botAlert(sid(9), "tech_lead", "x");
    expect(c.alerts).toHaveLength(1);
    c.exit(1); await settle();
    expect(() => sup.botAlert(id, "tech_lead", "again")).not.toThrow();
    expect(c.alerts).toHaveLength(1);
    c.send = () => { throw new Error("pipe"); };
    const r = await (async () => { const p = sup.restart(id); await settle(); children[1]!.emit(READY); return p; })();
    children[1]!.send = () => { throw new Error("pipe"); };
    expect(() => sup.botAlert(r.sessionId, "tech_lead", "x")).not.toThrow();
  });

  it("shutdown awaits bots.close() first; a Supervisor without bots still works", async () => {
    const sup = make();
    const { c } = await boot(sup);
    c.disconnect = () => { c.disconnected++; setImmediate(() => c.exit(0)); };
    calls.length = 0;
    await sup.shutdown();
    expect(calls[0]).toEqual({ op: "close", id: "" }); // before the children's exits are handled
    const plain = make(false);
    const { c: c2 } = await boot(plain);
    c2.exit(1); await settle();
    await plain.shutdown();
  });
});
