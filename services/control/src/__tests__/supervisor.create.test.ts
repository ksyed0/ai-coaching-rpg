import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlConfig } from "../config.js";
import type { ChildMessage, ParentMessage } from "../protocol.js";
import { SessionList } from "../session-list.js";
import { ControlError, Supervisor, type ChildHandle, type SetTimer, type SpawnFn } from "../supervisor.js";

class FakeChild implements ChildHandle {
  sent: ParentMessage[] = [];
  killed = 0;
  disconnected = 0;
  private msg: ((m: ChildMessage) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv, readonly logFile: string) {}
  send(m: ParentMessage): boolean { this.sent.push(m); return true; }
  onMessage(fn: (m: ChildMessage) => void): void { this.msg.push(fn); }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn); }
  kill(): void { this.killed++; }
  disconnect(): void { this.disconnected++; }
  emit(m: unknown): void { for (const f of this.msg) f(m as ChildMessage); }
  exit(code: number | null = 1): void { for (const f of this.exitFns) f(code); }
}

const CODES = [{ roleId: "cfo", code: "alpha-1" }, { roleId: "cto", code: "beta-2" }];
const READY = { type: "ready", port: 4321, status: "new", modelLabel: "test-model" } as const;
const sid = (n: number) => n.toString(16).padStart(32, "0");

let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, logs: string[];
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
const setTimer: SetTimer = (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const flush = () => new Promise<void>((r) => setImmediate(r));
const make = (extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) => new Supervisor({
  config, list, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }, { id: "other", title: "Other" }], spawn, setTimer,
  log: (m) => logs.push(m), ...extra,
});
const finish = async (c: FakeChild) => { c.emit({ type: "codes", codes: CODES }); c.emit(READY); };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-create-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "friday-escalation"), { recursive: true });
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 3, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 10, readyTimeoutMs: 5000,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; logs = []; timers = [];
  spawn = ({ env, logFile }) => {
    const c = new FakeChild(env, logFile);
    // simulate the runtime writing its seat files as soon as it starts
    const id = env.SESSION_ID!;
    for (const ext of ["jsonl", "lock", "codes.json", "credentials.json", "consent.json"]) writeFileSync(path.join(env.SESSION_DATA_DIR!, `${id}.${ext}`), "x");
    writeFileSync(logFile, "log");
    children.push(c);
    return c;
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Supervisor.create", () => {
  it("creates a session: codes, port and label returned; list and token handled", async () => {
    const sup = make();
    const p = sup.create("friday-escalation");
    await flush();
    expect(children).toHaveLength(1);
    expect(children[0]!.env.SESSION_START).toBe("fresh");
    expect(children[0]!.env.SCENARIO_DIR).toBe(path.join(config.scenariosDir, "friday-escalation"));
    expect(path.dirname(children[0]!.logFile)).toBe(config.logDir);
    await finish(children[0]!);
    const r = await p;
    expect(r).toEqual({ sessionId: children[0]!.env.SESSION_ID, status: "running", port: 4321, modelLabel: "test-model", codes: CODES });
    expect(/^[0-9a-f]{32}$/.test(r.sessionId)).toBe(true);
    expect(list.read()).toEqual([{ sessionId: r.sessionId, scenarioId: "friday-escalation", status: "running" }]);
    expect(sup.get(r.sessionId)).toEqual({ sessionId: r.sessionId, scenarioId: "friday-escalation", status: "running", port: 4321, modelLabel: "test-model" });
    expect(sup.list()).toHaveLength(1);
    expect(sup.get(sid(99))).toBeUndefined();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    expect((statSync(config.logDir).mode & 0o777).toString(8)).toBe("700");
  });

  it("a scenarioId outside the allowlist is refused before any spawn", async () => {
    const sup = make();
    for (const bad of ["nope", "../etc", "friday-escalation/../x", "", "FRIDAY-ESCALATION", "friday-escalation "]) {
      await expect(sup.create(bad)).rejects.toMatchObject({ code: "unknown_scenario" });
    }
    await expect(sup.create(undefined as unknown as string)).rejects.toBeInstanceOf(ControlError);
    expect(children).toHaveLength(0);
    expect(readdirSync(config.sessionsDir)).toEqual([]);
    expect(() => statSync(config.logDir)).toThrow();
  });

  it("two concurrent creates at MAX_SESSIONS - 1 produce one session, not two", async () => {
    list.upsert({ sessionId: sid(1), scenarioId: "other", status: "running" });
    list.upsert({ sessionId: sid(2), scenarioId: "other", status: "stopped" });
    const sup = make();
    const a = sup.create("friday-escalation");
    const b = sup.create("friday-escalation");
    const results = [a.then(() => "ok", (e: ControlError) => e.code), b.then(() => "ok", (e: ControlError) => e.code)];
    await flush(); await flush();
    expect(children).toHaveLength(1);
    await finish(children[0]!);
    expect((await Promise.all(results)).sort()).toEqual(["capacity", "ok"]);
    expect(list.read().filter((e) => e.status !== "ended")).toHaveLength(3);
  });

  it("refuses at capacity with a plain message", async () => {
    for (let i = 1; i <= 3; i++) list.upsert({ sessionId: sid(i), scenarioId: "other", status: "running" });
    await expect(make().create("other")).rejects.toMatchObject({ code: "capacity", message: "the maximum number of sessions is reached" });
    expect(children).toHaveLength(0);
  });

  it("ended sessions do not count against MAX_SESSIONS", async () => {
    for (let i = 1; i <= 8; i++) list.upsert({ sessionId: sid(i), scenarioId: "other", status: "ended" });
    const sup = make();
    const p = sup.create("other");
    await flush();
    await finish(children[0]!);
    await expect(p).resolves.toMatchObject({ status: "running" });
  });

  it("a child that exits before ready leaves no session-list entry, no codes file and no seat files", async () => {
    const sup = make();
    const p = sup.create("other");
    await flush();
    const id = children[0]!.env.SESSION_ID!;
    expect(readdirSync(config.sessionsDir).filter((f) => f.startsWith(`${id}.`))).not.toEqual([]);
    writeFileSync(path.join(config.sessionsDir, `${sid(77)}.jsonl`), "keep");
    children[0]!.emit({ type: "codes", codes: CODES });
    children[0]!.exit(1);
    await expect(p).rejects.toMatchObject({ code: "start_failed", message: "the session could not be started" });
    expect(list.read()).toEqual([]);
    expect(readdirSync(config.sessionsDir)).toEqual([`${sid(77)}.jsonl`]);
    expect(readdirSync(config.logDir)).toEqual([]);
    expect(sup.list()).toEqual([]);
    // the slot is free again
    const p2 = sup.create("other"); await flush(); await finish(children[1]!);
    await expect(p2).resolves.toBeDefined();
  });

  it("a child that never sends ready is killed after readyTimeoutMs and the create is rolled back", async () => {
    const sup = make();
    const p = sup.create("other");
    p.catch(() => {});
    await flush();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(config.readyTimeoutMs);
    children[0]!.emit({ type: "codes", codes: CODES });
    timers[0]!.fn();
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(children[0]!.killed).toBe(1);
    expect(list.read()).toEqual([]);
    expect(readdirSync(config.sessionsDir)).toEqual([]);
    expect(readdirSync(config.logDir)).toEqual([]);
  });

  it("codes without a following ready are discarded", async () => {
    const sup = make();
    const p = sup.create("other");
    p.catch(() => {});
    await flush();
    children[0]!.emit({ type: "codes", codes: CODES });
    children[0]!.exit(0);
    await expect(p).rejects.toMatchObject({ code: "start_failed" });
    // a late ready after the failure changes nothing
    children[0]!.emit(READY);
    expect(sup.list()).toEqual([]);
    expect(sup.facilitator(children[0]!.env.SESSION_ID!)).toBeUndefined();
  });

  it("ready with no codes for a new session is a failed start", async () => {
    const sup = make();
    const p = sup.create("other");
    p.catch(() => {});
    await flush();
    children[0]!.emit(READY);
    await expect(p).rejects.toMatchObject({ code: "start_failed" });
    expect(children[0]!.killed).toBe(1);
    expect(list.read()).toEqual([]);
  });

  it("invalid child messages are ignored", async () => {
    const sup = make();
    const p = sup.create("other");
    await flush();
    const c = children[0]!;
    c.emit(null); c.emit("ready"); c.emit({ type: "codes", codes: [{ roleId: "BAD", code: "" }] }); c.emit({ type: "ready", port: 0, status: "new", modelLabel: "m" });
    c.emit({ ...READY, extra: 1 });
    await finish(c);
    await expect(p).resolves.toMatchObject({ port: 4321, codes: CODES });
  });

  it("codes are returned once and never stored", async () => {
    const sup = make();
    const p = sup.create("other");
    await flush();
    await finish(children[0]!);
    const r = await p;
    const dump = JSON.stringify([sup.list(), sup.get(r.sessionId), sup.facilitator(r.sessionId)]) + readFileSync(config.listFile, "utf8") + logs.join("\n");
    for (const c of CODES) expect(dump).not.toContain(c.code);
    expect(JSON.stringify(sup)).not.toContain("alpha-1");
    expect(Object.values(sup as unknown as Record<string, unknown>).map((v) => JSON.stringify(v instanceof Map ? [...v.values()].map((x) => ({ ...x, child: undefined })) : (typeof v === "object" ? "" : v))).join()).not.toContain("alpha-1");
  });

  it("the facilitator token is only returned by facilitator(id) for a running session", async () => {
    const sup = make();
    const p = sup.create("other");
    await flush();
    const c = children[0]!;
    await finish(c);
    const r = await p;
    const token = c.env.FACILITATOR_TOKEN!;
    expect(sup.facilitator(r.sessionId)).toEqual({ port: 4321, token });
    expect(sup.facilitator(sid(5))).toBeUndefined();
    const everythingElse = JSON.stringify([r, sup.get(r.sessionId), sup.list()]) + readFileSync(config.listFile, "utf8") + logs.join("\n") + c.logFile;
    expect(everythingElse).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });

  it("token is 64 hex characters and differs per create (default generator)", async () => {
    const sup = make();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = sup.create("other"); await flush(); await finish(children[i]!); await p;
      tokens.push(children[i]!.env.FACILITATOR_TOKEN!);
    }
    expect(tokens.every((t) => /^[0-9a-f]{64}$/.test(t))).toBe(true);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(children[0]!.env.SESSION_ID).not.toBe(children[1]!.env.SESSION_ID);
  });

  it("child log directory is mode 0700 and the token never appears in the list file or log output", async () => {
    const sup = make();
    const p = sup.create("other");
    await flush();
    const c = children[0]!;
    await finish(c);
    await p;
    expect((statSync(config.logDir).mode & 0o777).toString(8)).toBe("700");
    expect(readFileSync(config.listFile, "utf8")).not.toContain(c.env.FACILITATOR_TOKEN!);
    expect(logs.join("\n")).not.toContain(c.env.FACILITATOR_TOKEN!);
    // the 0600 mode of the log FILE belongs to the real spawn and is asserted in the Task 12 test
  });

  it("a spawn that throws is rolled back as start_failed", async () => {
    const sup = make({ spawn: () => { throw new Error("EACCES /secret/path"); } });
    await expect(sup.create("other")).rejects.toMatchObject({ code: "start_failed", message: "the session could not be started" });
    expect(list.read()).toEqual([]);
  });

  it("11b methods are stubs", async () => {
    const sup = make();
    await expect(sup.restart(sid(1))).rejects.toThrow("not implemented");
    await expect(sup.shutdown()).rejects.toThrow("not implemented");
  });
});
