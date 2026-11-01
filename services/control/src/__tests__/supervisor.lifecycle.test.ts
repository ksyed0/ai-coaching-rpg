import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlConfig } from "../config.js";
import { SessionList } from "../session-list.js";
import { ControlError, Supervisor, type SetTimer, type SpawnFn } from "../supervisor.js";
import { CODES, FakeChild, READY, flush, sid } from "./fake-child.js";

type T = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, logs: string[], timers: T[];
let onSpawn: ((c: FakeChild) => void) | undefined;
const setTimer: SetTimer = (fn, ms) => { const t: T = { fn, ms, cancelled: false, fired: false }; timers.push(t); return () => { t.cancelled = true; }; };
const pending = (ms?: number): T[] => timers.filter((t) => !t.cancelled && !t.fired && (ms === undefined || t.ms === ms));
const fire = (t: T): void => { t.fired = true; t.fn(); };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await flush(); };
const make = (extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) => new Supervisor({
  config, list, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }, { id: "other", title: "Other" }], spawn, setTimer,
  log: (m) => logs.push(m), now: () => 1234, ...extra,
});
const dies = (c: FakeChild) => { c.onKill = () => setImmediate(() => c.exit(null)); };
const boot = async (sup: Supervisor): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other");
  await settle();
  const c = children[children.length - 1]!;
  c.emit({ type: "codes", codes: CODES }); c.emit(READY);
  const r = await p;
  return { id: r.sessionId, c };
};
const errOf = (p: Promise<unknown>): Promise<ControlError> => p.then(() => { throw new Error("expected a rejection"); }, (e: ControlError) => e);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-life-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "friday-escalation"), { recursive: true });
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 777, readyTimeoutMs: 5000,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; logs = []; timers = []; onSpawn = undefined;
  spawn = ({ env, logFile }) => {
    const c = new FakeChild(env, logFile);
    writeFileSync(logFile, "log");
    onSpawn?.(c);
    children.push(c);
    return c;
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Supervisor lifecycle", () => {
  it("an unexpected exit marks the session stopped and is not restarted automatically", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.exit(137);
    await settle();
    expect(list.read()).toEqual([{ sessionId: id, scenarioId: "other", status: "stopped" }]);
    expect(sup.get(id)).toEqual({ sessionId: id, scenarioId: "other", status: "stopped" });
    expect(sup.facilitator(id)).toBeUndefined();
    expect(children).toHaveLength(1);
    expect(pending()).toEqual([]);
    expect(logs.some((l) => l.includes(id) && l.includes("stopped"))).toBe(true);
  });

  it("the ended message persists ended and the child is stopped after graceMs (injected timers)", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.emit({ type: "ended" });
    expect(list.read()[0]!.status).toBe("ended");
    expect(sup.get(id)!.status).toBe("ended");
    expect(sup.facilitator(id)).toBeUndefined();
    expect(c.killed).toBe(0);
    const t = pending(777);
    expect(t).toHaveLength(1);
    dies(c);
    fire(t[0]!);
    await settle();
    expect(c.killed).toBe(1);
    expect(c.forced).toBe(0);
    c.emit({ type: "ended" }); // a repeat changes nothing
    expect(pending(777)).toEqual([]);
  });

  it("the exit after ended does not turn ended into stopped", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.emit({ type: "ended" });
    c.exit(0);
    await settle();
    expect(list.read()[0]!.status).toBe("ended");
    expect(sup.get(id)!.status).toBe("ended");
    expect(pending()).toEqual([]);
    // the ended session does not hold a slot
    config.maxSessions = 1;
    const p = sup.create("other"); await settle(); children[1]!.emit({ type: "codes", codes: CODES }); children[1]!.emit(READY);
    await expect(p).resolves.toMatchObject({ status: "running" });
  });

  it("an ended delivered in the same burst as ready is not lost (create): the session ends up ended (BUG-0016)", async () => {
    const sup = make();
    const p = sup.create("other");
    await settle();
    const c = children[children.length - 1]!;
    c.emit({ type: "codes", codes: CODES }); c.emit(READY); c.emit({ type: "ended" });
    const r = await p;
    await settle();
    expect(sup.get(r.sessionId)!.status).toBe("ended");
    expect(list.read()[0]!.status).toBe("ended");
    expect(sup.facilitator(r.sessionId)).toBeUndefined();
  });

  it("an ended delivered in the same burst as ready is not lost (restart): the session ends up ended (BUG-0016)", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.exit(1);
    await settle();
    const p = sup.restart(id);
    await settle();
    const c2 = children[1]!;
    c2.emit({ type: "ready", port: 5555, status: "resumed", modelLabel: "m2" }); c2.emit({ type: "ended" });
    await p;
    await settle();
    expect(sup.get(id)!.status).toBe("ended");
    expect(list.read()[0]!.status).toBe("ended");
  });

  it("restart is refused for ended and resumes a stopped session paused with a new token", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.exit(1);
    await settle();
    const first = c.env.FACILITATOR_TOKEN!;
    const p = sup.restart(id);
    await settle();
    expect(children).toHaveLength(2);
    const c2 = children[1]!;
    expect(c2.env.SESSION_START).toBe("resume");
    expect(c2.env.SESSION_ID).toBe(id);
    expect(c2.env.FACILITATOR_TOKEN).not.toBe(first);
    expect(sup.get(id)!.status).toBe("stopped"); // not running until ready
    expect(pending(5000)).toHaveLength(1);
    c2.emit({ type: "ready", port: 5555, status: "resumed", modelLabel: "m2" });
    await expect(p).resolves.toEqual({ sessionId: id, scenarioId: "other", status: "running", port: 5555, modelLabel: "m2" });
    expect(list.read()[0]!.status).toBe("running");
    expect(sup.facilitator(id)).toEqual({ port: 5555, token: c2.env.FACILITATOR_TOKEN });
    expect(pending()).toEqual([]);

    c2.emit({ type: "ended" }); c2.exit(0); await settle();
    expect(await errOf(sup.restart(id))).toMatchObject({ code: "conflict", message: "the session has ended" });
    list.upsert({ sessionId: sid(9), scenarioId: "other", status: "ended" });
    expect(await errOf(sup.restart(sid(9)))).toMatchObject({ code: "conflict" });
    expect(await errOf(sup.restart(sid(8)))).toMatchObject({ code: "not_found" });
    expect(await errOf(sup.restart("../x"))).toMatchObject({ code: "not_found" });
    expect(children).toHaveLength(2);
  });

  it("restart of a running session is a conflict", async () => {
    const sup = make();
    const { id } = await boot(sup);
    expect(await errOf(sup.restart(id))).toMatchObject({ code: "conflict", message: "already running" });
    expect(children).toHaveLength(1);
  });

  it("restart surfaces codes exactly once if the child issued new ones, and none when the lobby is kept (ready without codes is normal)", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.exit(1); await settle();
    const p = sup.restart(id); await settle();
    children[1]!.emit({ type: "codes", codes: [{ roleId: "cfo", code: "fresh-7" }] });
    children[1]!.emit({ type: "ready", port: 6001, status: "resumed", modelLabel: "m" });
    const r = await p;
    expect(r.codes).toEqual([{ roleId: "cfo", code: "fresh-7" }]);
    expect(sup.get(id)).not.toHaveProperty("codes");
    expect(sup.list()[0]).not.toHaveProperty("codes");
    expect(JSON.stringify(sup.facilitator(id))).not.toContain("fresh-7");

    children[1]!.exit(1); await settle();
    const p2 = sup.restart(id); await settle();
    children[2]!.emit({ type: "ready", port: 6002, status: "resumed", modelLabel: "m" });
    const r2 = await p2;
    expect(r2).not.toHaveProperty("codes");
    expect(r2.status).toBe("running");
    expect(logs.join("\n") + readFileSync(config.listFile, "utf8")).not.toContain("fresh-7");
  });

  it("resumeAll checks the log tail first: a session whose log ends with session.ended is marked ended and not spawned", async () => {
    list.upsert({ sessionId: sid(1), scenarioId: "other", status: "running" });
    list.upsert({ sessionId: sid(2), scenarioId: "other", status: "stopped" });
    list.upsert({ sessionId: sid(3), scenarioId: "other", status: "ended" });
    writeFileSync(path.join(config.sessionsDir, `${sid(1)}.jsonl`), '{"type":"x"}\n{"type":"session.ended"}\n');
    writeFileSync(path.join(config.sessionsDir, `${sid(2)}.jsonl`), '{"type":"x"}\n');
    const sup = make();
    const p = sup.resumeAll();
    await settle();
    expect(children.map((c) => c.env.SESSION_ID)).toEqual([sid(2)]);
    expect(children[0]!.env.SESSION_START).toBe("resume");
    children[0]!.emit(READY);
    await p;
    expect(list.read().map((e) => e.status)).toEqual(["ended", "running", "ended"]);
    expect(sup.get(sid(1))!.status).toBe("ended");
    expect(sup.get(sid(2))!.status).toBe("running");
    // already running in memory: skipped on a second call
    await sup.resumeAll();
    expect(children).toHaveLength(1);
  });

  it("resumeAll waits for a previous child to exit before spawning", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    // a stop that cannot finish: the child ignores kill and forceKill, so the session is marked stopped with the child still alive
    const stuck = errOf(sup.reissueAll(id));
    await settle();
    fire(pending(777)[0]!); await settle();
    fire(pending(777)[0]!);
    await stuck;
    expect(sup.get(id)!.status).toBe("stopped");
    const r = sup.resumeAll();
    await settle();
    expect(children).toHaveLength(1);
    const wait = pending(777);
    expect(wait).toHaveLength(1);
    c.exit(null);
    await settle();
    expect(children).toHaveLength(2);
    expect(pending(777)).toEqual([]);
    children[1]!.emit(READY);
    await r;
    expect(sup.get(id)!.status).toBe("running");

    // and when the old child never leaves, the session stays stopped and resumeAll still settles
    const stuck2 = errOf(sup.reissueAll(id));
    await settle();
    fire(pending(777)[0]!); await settle();
    fire(pending(777)[0]!);
    await stuck2;
    const r2 = sup.resumeAll();
    await settle();
    fire(pending(777)[0]!);
    await r2;
    expect(children).toHaveLength(2);
    expect(sup.get(id)!.status).toBe("stopped");
  });

  it("a hung child does not stop resumeAll from settling and the service from listening", async () => {
    list.upsert({ sessionId: sid(1), scenarioId: "other", status: "stopped" });
    list.upsert({ sessionId: sid(2), scenarioId: "other", status: "running" });
    const sup = make();
    const settled = sup.resumeAll().then(() => "done");
    await settle();
    expect(children).toHaveLength(2);
    dies(children[1]!);
    children[0]!.emit(READY);
    await settle();
    const hung = pending(5000);
    expect(hung).toHaveLength(1);
    fire(hung[0]!);
    await expect(settled).resolves.toBe("done");
    expect(children[1]!.killed).toBe(1);
    expect(sup.get(sid(1))!.status).toBe("running");
    expect(sup.get(sid(2))!.status).toBe("stopped");
    expect(list.read().map((e) => e.status)).toEqual(["running", "stopped"]);
    expect(pending()).toEqual([]);
  });

  it("a failing log-tail check marks the session stopped and continues", async () => {
    list.upsert({ sessionId: sid(1), scenarioId: "other", status: "running" });
    list.upsert({ sessionId: sid(2), scenarioId: "other", status: "running" });
    mkdirSync(path.join(config.sessionsDir, `${sid(1)}.jsonl`)); // unreadable as a log
    const sup = make();
    const p = sup.resumeAll();
    await settle();
    expect(children.map((c) => c.env.SESSION_ID)).toEqual([sid(2)]);
    children[0]!.emit(READY);
    await p;
    expect(list.read().map((e) => e.status)).toEqual(["stopped", "running"]);
    expect(logs.some((l) => l.includes(sid(1)) && l.includes("log"))).toBe(true);
    expect(logs.join("\n")).not.toContain(root);
  });

  it("codes that are not followed by ready are discarded", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    c.exit(1); await settle();
    const p = errOf(sup.restart(id)); await settle();
    children[1]!.emit({ type: "codes", codes: [{ roleId: "cfo", code: "ghost-3" }] });
    children[1]!.exit(1);
    expect(await p).toMatchObject({ code: "start_failed", message: "the session could not be started" });
    children[1]!.emit(READY);
    expect(sup.get(id)!.status).toBe("stopped");
    expect(sup.facilitator(id)).toBeUndefined();
    expect(JSON.stringify(Object.values(sup as unknown as Record<string, unknown>).map((v) => (v instanceof Map ? [...v.values()].map((x) => ({ ...x, child: undefined, exit: undefined })) : typeof v === "object" ? "" : v)))).not.toContain("ghost-3");
    expect(logs.join("\n")).not.toContain("ghost-3");
  });

  describe("reissue", () => {
    it("reissue sends the IPC request with the console name and returns the code; a reissue_failed reply rejects with a plain reason", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      const p = sup.reissue(id, "cfo", "Pat Q");
      await settle();
      expect(c.sent).toHaveLength(1);
      const m = c.sent[0]!;
      expect(m).toMatchObject({ type: "reissue", roleId: "cfo", by: "Pat Q" });
      expect(m.requestId).toMatch(/^[0-9a-f]{16}$/);
      c.emit({ type: "reissued", requestId: "0".repeat(16), code: "WRONG" }); // another request: ignored
      c.emit({ type: "reissued", requestId: m.requestId, code: "newcode-9" });
      await expect(p).resolves.toBe("newcode-9");
      expect(pending()).toEqual([]);

      const p2 = errOf(sup.reissue(id, "cto"));
      await settle();
      c.emit({ type: "reissue_failed", requestId: c.sent[1]!.requestId, reason: "that role is not seated" });
      expect(await p2).toMatchObject({ code: "conflict", message: "that role is not seated" });
      expect(c.sent[1]).not.toHaveProperty("by");

      expect(await errOf(sup.reissue(id, "BAD"))).toMatchObject({ code: "bad_request" });
      expect(await errOf(sup.reissue(id, "cfo", "x".repeat(201)))).toMatchObject({ code: "bad_request" });
      expect(await errOf(sup.reissue(sid(4), "cfo"))).toMatchObject({ code: "not_found" });
      c.exit(1); await settle();
      expect(await errOf(sup.reissue(id, "cfo"))).toMatchObject({ code: "conflict" });
      expect(c.sent).toHaveLength(2);
    });

    it("a remove passes reason removed through to the child, and its fixed refusal rejects as a conflict", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      const p = errOf(sup.reissue(id, "cfo", undefined, "removed"));
      await settle();
      expect(c.sent[0]).toMatchObject({ type: "reissue", roleId: "cfo", reason: "removed" });
      c.emit({ type: "reissue_failed", requestId: c.sent[0]!.requestId, reason: "a participant can only be removed before the start" });
      expect(await p).toMatchObject({ code: "conflict", message: "a participant can only be removed before the start" });
    });

    it("a reissue that gets no reply rejects with the unknown-outcome error and is not retried", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      const p = errOf(sup.reissue(id, "cfo"));
      await settle();
      const t = pending(15_000);
      expect(t).toHaveLength(1);
      fire(t[0]!);
      expect(await p).toMatchObject({ code: "timeout", message: "the reissue may or may not have happened; reissue again" });
      await settle();
      expect(c.sent).toHaveLength(1);
      expect(pending()).toEqual([]);
      // a late reply is ignored; the role can be reissued again
      c.emit({ type: "reissued", requestId: c.sent[0]!.requestId, code: "late-1" });
      const p2 = sup.reissue(id, "cfo"); await settle();
      c.emit({ type: "reissued", requestId: c.sent[1]!.requestId, code: "ok-2" });
      await expect(p2).resolves.toBe("ok-2");
    });

    it("the timeout is configurable and a child that exits mid-request rejects plainly", async () => {
      const sup = make({ reissueTimeoutMs: 42 });
      const { id, c } = await boot(sup);
      const p = errOf(sup.reissue(id, "cfo")); await settle();
      expect(pending(42)).toHaveLength(1);
      c.exit(1);
      expect(await p).toMatchObject({ code: "unavailable" });
      expect(pending()).toEqual([]);
    });

    it("two concurrent reissues for the same role: the second is refused", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      const first = sup.reissue(id, "cfo");
      const second = errOf(sup.reissue(id, "cfo"));
      expect(await second).toMatchObject({ code: "conflict" });
      // a different role is serialised, not refused
      const other = sup.reissue(id, "cto");
      await settle();
      expect(c.sent).toHaveLength(1);
      c.emit({ type: "reissued", requestId: c.sent[0]!.requestId, code: "a-1" });
      await expect(first).resolves.toBe("a-1");
      await settle();
      expect(c.sent).toHaveLength(2);
      c.emit({ type: "reissued", requestId: c.sent[1]!.requestId, code: "b-2" });
      await expect(other).resolves.toBe("b-2");
    });
  });

  describe("reissueAll", () => {
    it("reissueAll before the start returns a full new set, moves the codes file aside and the old codes stop working; after the start it is refused with a plain message", async () => {
      const seen: { codesFile: boolean }[] = [];
      const sup = make();
      const { id, c } = await boot(sup);
      const codesFile = path.join(config.sessionsDir, `${id}.codes.json`);
      writeFileSync(codesFile, '{"hashes":"old"}');
      dies(c);
      onSpawn = () => { seen.push({ codesFile: existsSync(codesFile) }); };
      const p = sup.reissueAll(id, "Pat");
      await settle();
      expect(c.killed).toBe(1);
      expect(children).toHaveLength(2);
      expect(seen).toEqual([{ codesFile: false }]);
      expect(readdirSync(config.sessionsDir)).toEqual([`${id}.codes.json.reissued-1234`]);
      const c2 = children[1]!;
      expect(c2.env.SESSION_START).toBe("resume");
      expect(c2.env.FACILITATOR_TOKEN).not.toBe(c.env.FACILITATOR_TOKEN);
      const fresh = [{ roleId: "cfo", code: "n-1" }, { roleId: "cto", code: "n-2" }];
      c2.emit({ type: "codes", codes: fresh }); c2.emit({ ...READY, port: 7001 });
      await expect(p).resolves.toEqual(fresh);
      expect(sup.get(id)).toMatchObject({ status: "running", port: 7001 });
      expect(list.read()[0]!.status).toBe("running");
      expect(sup.facilitator(id)).toEqual({ port: 7001, token: c2.env.FACILITATOR_TOKEN });
      expect(pending()).toEqual([]);

      writeFileSync(path.join(config.sessionsDir, `${id}.jsonl`), '{"type":"session.started"}\n');
      const refused = await errOf(sup.reissueAll(id));
      expect(refused).toMatchObject({ code: "conflict", message: "codes can only be reissued for the whole session before it starts" });
      expect(c2.killed).toBe(0);
      expect(children).toHaveLength(2);
      expect(await errOf(sup.reissueAll(sid(7)))).toMatchObject({ code: "not_found" });
    });

    it("works for a stopped session, tolerates a missing codes file, refuses ended and fails safe when no codes come", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      c.exit(1); await settle();
      const p = sup.reissueAll(id); await settle();
      expect(children).toHaveLength(2);
      children[1]!.emit({ type: "codes", codes: CODES }); children[1]!.emit(READY);
      await expect(p).resolves.toEqual(CODES);

      // ready without codes after a reissue-all is a failed start: the child is stopped and the session is stopped
      dies(children[1]!);
      const q = errOf(sup.reissueAll(id)); await settle();
      dies(children[2]!);
      children[2]!.emit(READY);
      expect(await q).toMatchObject({ code: "start_failed" });
      await settle();
      expect(sup.get(id)!.status).toBe("stopped");
      expect(list.read()[0]!.status).toBe("stopped");

      list.upsert({ sessionId: sid(5), scenarioId: "other", status: "ended" });
      expect(await errOf(sup.reissueAll(sid(5)))).toMatchObject({ code: "conflict", message: "the session has ended" });
    });

    const STARTED_MSG = "codes can only be reissued for the whole session before it starts";
    const startDuringStop = async (sup: Supervisor) => {
      const { id, c } = await boot(sup);
      const codesFile = path.join(config.sessionsDir, `${id}.codes.json`);
      writeFileSync(codesFile, '{"hashes":"old"}');
      c.onKill = () => {
        writeFileSync(path.join(config.sessionsDir, `${id}.jsonl`), '{"type":"session.started"}\n'); // a player starts it mid-stop
        setImmediate(() => c.exit(null));
      };
      return { id, c, codesFile };
    };

    it("a session that starts while the old child is stopping keeps its codes file and is relaunched unchanged, then the call is refused", async () => {
      const sup = make();
      const { id, c, codesFile } = await startDuringStop(sup);
      const q = errOf(sup.reissueAll(id)); await settle();
      expect(children).toHaveLength(2);
      const c2 = children[1]!;
      expect(c2.env.SESSION_START).toBe("resume");
      expect(c2.env.FACILITATOR_TOKEN).not.toBe(c.env.FACILITATOR_TOKEN);
      c2.emit(READY);
      expect(await q).toMatchObject({ code: "conflict", message: STARTED_MSG });
      expect(existsSync(codesFile)).toBe(true);
      expect(readdirSync(config.sessionsDir).filter((f) => f.includes("reissued"))).toEqual([]);
      expect(sup.get(id)!.status).toBe("running");
      expect(sup.facilitator(id)).toEqual({ port: 4321, token: c2.env.FACILITATOR_TOKEN });
      expect(logs.join("\n")).not.toContain("alpha-1");
    });

    it("if that relaunch fails the session ends stopped and the call is still refused", async () => {
      const sup = make();
      const { id, codesFile } = await startDuringStop(sup);
      const q = errOf(sup.reissueAll(id)); await settle();
      children[1]!.exit(1);
      expect(await q).toMatchObject({ code: "conflict", message: STARTED_MSG });
      expect(existsSync(codesFile)).toBe(true);
      expect(sup.get(id)!.status).toBe("stopped");
      expect(list.read()[0]!.status).toBe("stopped");
    });

    it("a ready timeout stops the new child, keeps the session files and marks the session stopped", async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      dies(c);
      const seat = path.join(config.sessionsDir, `${id}.jsonl.keep`);
      writeFileSync(seat, "keep");
      const q = errOf(sup.reissueAll(id)); await settle();
      dies(children[1]!);
      fire(pending(5000)[0]!);
      expect(await q).toMatchObject({ code: "timeout" });
      expect(children[1]!.killed).toBe(1);
      expect(existsSync(seat)).toBe(true);
      expect(list.read()).toHaveLength(1);
      expect(list.read()[0]!.status).toBe("stopped");
    });
  });

  it("child stdout and stderr go to the per-session log file", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    expect(c.logFile).toBe(path.join(config.logDir, `${id}.log`));
    c.exit(1); await settle();
    const p = sup.restart(id); await settle();
    children[1]!.emit(READY); await p;
    expect(children[1]!.logFile).toBe(c.logFile);
    dies(children[1]!);
    const q = sup.reissueAll(id); await settle();
    children[2]!.emit({ type: "codes", codes: CODES }); children[2]!.emit(READY); await q;
    expect(children[2]!.logFile).toBe(c.logFile);
  });

  it("shutdown disconnects every child, forces stragglers and leaves no timers", async () => {
    const sup = make();
    const a = await boot(sup);
    const b = await boot(sup);
    const e = await boot(sup);
    e.c.emit({ type: "ended" }); // grace timer pending
    const rp = errOf(sup.reissue(b.id, "cfo")); // reissue timer pending
    await settle();
    expect(pending().length).toBe(2);
    a.c.disconnect = () => { a.c.disconnected++; setImmediate(() => a.c.exit(0)); };
    const done = sup.shutdown().then(() => "done");
    await settle();
    for (const x of [a, b, e]) expect(x.c.disconnected).toBe(1);
    expect(await rp).toMatchObject({ code: "unavailable" });
    const wait = pending(777);
    expect(wait).toHaveLength(1);
    fire(wait[0]!);
    await settle();
    expect(b.c.forced).toBe(1);
    expect(e.c.forced).toBe(1);
    expect(a.c.forced).toBe(0);
    b.c.exit(null); e.c.exit(null);
    await expect(done).resolves.toBe("done");
    expect(pending()).toEqual([]);
    await sup.shutdown(); // idempotent
  });

  it("no token or code appears in any log callback output or the list file in any lifecycle path", async () => {
    const sup = make();
    const a = await boot(sup);
    const rp = sup.reissue(a.id, "cfo", "Pat"); await settle();
    a.c.emit({ type: "reissued", requestId: a.c.sent[0]!.requestId, code: "secret-code-1" }); await rp;
    a.c.exit(1); await settle();
    const rs = sup.restart(a.id); await settle();
    children[1]!.emit({ type: "codes", codes: [{ roleId: "cfo", code: "secret-code-2" }] }); children[1]!.emit(READY);
    await rs;
    dies(children[1]!);
    const ra = sup.reissueAll(a.id); await settle();
    children[2]!.emit({ type: "codes", codes: [{ roleId: "cfo", code: "secret-code-3" }] }); children[2]!.emit(READY);
    await ra;
    children[2]!.emit({ type: "ended" });
    list.upsert({ sessionId: sid(3), scenarioId: "other", status: "stopped" });
    const all = sup.resumeAll(); await settle(); children[3]!.emit({ type: "codes", codes: [{ roleId: "cfo", code: "secret-code-4" }] }); children[3]!.emit(READY); await all;
    const dump = logs.join("\n") + readFileSync(config.listFile, "utf8") + JSON.stringify(sup.list());
    for (const s of ["secret-code-1", "secret-code-2", "secret-code-3", "secret-code-4", ...CODES.map((x) => x.code), ...children.map((x) => x.env.FACILITATOR_TOKEN!)]) {
      expect(dump).not.toContain(s);
    }
    expect(children[3]!.env.SESSION_ID).toBe(sid(3));
  });
});
