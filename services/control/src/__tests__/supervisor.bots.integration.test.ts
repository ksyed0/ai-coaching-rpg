import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { BotHost } from "../bots/bot-host.js";
import type { BotSocket, BotSocketOptions } from "../bots/bot-socket.js";
import { IntentLog } from "../bots/intent-log.js";
import type { ControlConfig } from "../config.js";
import { SessionList } from "../session-list.js";
import { Supervisor, type BotDeps, type SetTimer, type SpawnFn } from "../supervisor.js";
import { AI_ROLES_REFUSED } from "../../../runtime/src/host/set-ai-roles.js";
import { AI_CONFIG, FakeChild, READY, flush } from "./fake-child.js";

/** The Supervisor with a REAL BotHost (only the socket factory is fake): what a role switched to AI after the session went live really does. */
const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios/friday-escalation");
const ROLES = ["delivery_lead", "tech_lead", "account_manager"];
const CODES = ROLES.map((roleId) => ({ roleId, code: `human-${roleId}` }));

let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, scenario: Scenario;
let opened: { roleId: string; code: string; port: number; closed: boolean }[], reissues: string[], logs: string[], host: BotHost | undefined;
type Tm = { ms: number; fn: () => void; cancelled: boolean; fired: boolean };
let timers: Tm[];
const setTimer: SetTimer = (fn, ms) => { const t: Tm = { ms, fn, cancelled: false, fired: false }; timers.push(t); return () => { t.cancelled = true; }; };
const fireSet = (): void => { const t = timers.filter((x) => x.ms === 4242 && !x.cancelled && !x.fired).pop()!; t.fired = true; t.fn(); };
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await flush(); };
const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  const rec = { roleId: o.roleId, code: o.code, port: o.port, closed: false };
  opened.push(rec);
  return { say: () => undefined, close: async () => { rec.closed = true; } } as unknown as BotSocket;
};

const make = () => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, reissueTimeoutMs: 4242, log: (m) => logs.push(m),
  bots: (d: BotDeps) => {
    host = new BotHost({
      provider: new MockModelProvider(), settings: AI_CONFIG.aiPlayer, intents: new IntentLog(path.join(root, "intents")),
      scenarioFor: async () => scenario, log: (m) => logs.push(m), setTimer, open,
      reissue: async (id, roleId) => { reissues.push(roleId); return d.reissue(id, roleId); }, alert: d.alert,
    });
    return host;
  },
});
const boot = async (sup: Supervisor): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other"); await settle();
  const c = children[children.length - 1]!;
  c.emit({ type: "codes", codes: CODES }); c.emit(READY);
  const r = await p; await settle();
  return { id: r.sessionId, c };
};
const set = async (sup: Supervisor, id: string, c: FakeChild, roles: string[], codes: { roleId: string; code: string }[]) => {
  const p = sup.setAiRoles(id, roles); await settle();
  c.emit({ type: "ai_roles_set", requestId: c.sent[c.sent.length - 1]!.requestId, codes });
  const r = await p; await settle();
  return r;
};

beforeEach(async () => {
  scenario = await loadScenario(SCENARIO_DIR);
  root = mkdtempSync(path.join(tmpdir(), "ctl-botsint-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 777, readyTimeoutMs: 5000, ...AI_CONFIG,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; timers = []; opened = []; reissues = []; logs = []; host = undefined;
  spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); writeFileSync(logFile, "log"); children.push(c); return c; };
});
afterEach(async () => { await host?.close(); rmSync(root, { recursive: true, force: true }); });

describe("Supervisor with a real BotHost", () => {
  it("create then setAiRoles([tech_lead]): exactly one socket opens with that role's new code, and nothing is reissued", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    expect(opened).toEqual([]);
    const r = await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-code-1" }]);
    expect(r).toEqual({ roles: ["tech_lead"], codes: [] });
    expect(opened.map((o) => [o.roleId, o.code, o.port])).toEqual([["tech_lead", "ai-code-1", 4321]]);
    expect(reissues).toEqual([]);
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
    expect(logs.join("\n")).not.toContain("ai-code-1");
  });

  it("leave then re-enter: the bot is stopped, then a new one opens with the NEW code", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-code-1" }]);
    const back = await set(sup, id, c, [], [{ roleId: "tech_lead", code: "human-again" }]);
    expect(back).toEqual({ roles: [], codes: [{ roleId: "tech_lead", code: "human-again" }] });
    expect(opened[0]!.closed).toBe(true);
    await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-code-2" }]);
    expect(opened.map((o) => [o.roleId, o.code])).toEqual([["tech_lead", "ai-code-1"], ["tech_lead", "ai-code-2"]]);
    expect(opened[1]!.closed).toBe(false);
    expect(reissues).toEqual([]);
  });

  it("reissueAll with tech_lead AI: the bot ends attached with the NEW code on the new child, and the result holds human roles only", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-old" }]);
    expect(opened.map((o) => o.code)).toEqual(["ai-old"]);
    c.onKill = () => setImmediate(() => c.exit(null));
    const p = sup.reissueAll(id); await settle();
    const c2 = children[children.length - 1]!;
    const fresh = ROLES.map((roleId) => ({ roleId, code: `fresh-${roleId}` }));
    c2.emit({ type: "codes", codes: fresh }); c2.emit({ ...READY, port: 7001 }); await settle();
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-new" }] });
    const r = await Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung")), 1500))]);
    await settle();
    expect(r).toEqual(fresh.filter((x) => x.roleId !== "tech_lead"));
    expect(c2.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
    const last = opened[opened.length - 1]!;
    expect([last.roleId, last.code, last.port, last.closed]).toEqual(["tech_lead", "ai-new", 7001, false]);
    expect(opened.filter((o) => !o.closed)).toHaveLength(1);
    expect(reissues).toEqual([]);
  });

  it("a recovery reissue that times out after the set applied keeps every role uncertain; the third set gives the bots their codes", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const last = (): { type: string; requestId: string } => c.sent[c.sent.length - 1]! as { type: string; requestId: string };
    // 1: the set times out (it may have applied)
    const s1 = sup.setAiRoles(id, ["tech_lead"]).catch((e: Error & { code?: string }) => e); await settle();
    fireSet();
    expect(await s1).toMatchObject({ code: "timeout" });
    // 2: this set applies (account_manager's code arrives) but the recovery reissue of tech_lead times out
    const s2 = sup.setAiRoles(id, ["tech_lead", "account_manager"]).catch((e: Error & { code?: string; message: string }) => e); await settle();
    c.emit({ type: "ai_roles_set", requestId: last().requestId, codes: [{ roleId: "account_manager", code: "ai-am-lost" }] }); await settle();
    expect(last().type).toBe("reissue");
    fireSet();
    const e2 = await s2 as { code: string; message: string };
    expect(e2).toMatchObject({ code: "timeout", message: "the AI roles may or may not have changed; reissue the changed roles" });
    expect(opened).toEqual([]);
    expect(await sup.reissue(id, "account_manager").catch((e: Error & { code?: string }) => e)).toMatchObject({ code: "ai_role" });
    // 3: a retry recovers both: the reply covers nothing, each uncertain role is reissued and routed to the bots by the wanted set
    const s3 = sup.setAiRoles(id, ["tech_lead", "account_manager"]); await settle();
    c.emit({ type: "ai_roles_set", requestId: last().requestId, codes: [] }); await settle();
    expect(last()).toMatchObject({ type: "reissue" });
    c.emit({ type: "reissued", requestId: last().requestId, code: "ai-tl-3" }); await settle();
    c.emit({ type: "reissued", requestId: last().requestId, code: "ai-am-3" });
    expect(await s3).toEqual({ roles: ["tech_lead", "account_manager"].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b)), codes: [] });
    await settle();
    expect(opened.map((o) => [o.roleId, o.code]).sort()).toEqual([["account_manager", "ai-am-3"], ["tech_lead", "ai-tl-3"]]);
    expect(reissues).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/ai-(tl|am)/);
  });

  describe("the bots' own reissue (C1)", () => {
    /** A session whose tech_lead is AI per the supervisor, with the host holding no code for it. */
    const setup = async () => {
      const sup = make();
      const { id, c } = await boot(sup);
      await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-1" }]);
      await host!.forget(id); await settle();
      opened.length = 0; c.sent.length = 0;
      return { sup, id, c };
    };
    const types = (c: FakeChild): string[] => c.sent.map((m) => m.type);

    it("(a) a bot reissue queued behind a TIMED-OUT set that made the role human is refused: nothing is sent, no bot opens", async () => {
      const { sup, id, c } = await setup();
      const s = sup.setAiRoles(id, []).catch((e: Error & { code?: string }) => e); await settle();
      void host!.attach(id, { port: 4321, aiRoles: ["tech_lead"] }); await settle(); // no code: the bot asks for one, queued behind the lock
      fireSet();
      expect(await s).toMatchObject({ code: "timeout" });
      await settle();
      expect(types(c)).toEqual(["set_ai_roles"]);
      expect(opened).toEqual([]);
    });

    it("(b) behind a SUCCESSFUL set that made the role human, and behind a reissueAll with no AI role: not sent", async () => {
      const { sup, id, c } = await setup();
      const s = sup.setAiRoles(id, []); await settle();
      void host!.attach(id, { port: 4321, aiRoles: ["tech_lead"] }); await settle();
      c.emit({ type: "ai_roles_set", requestId: c.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "human-new" }] });
      expect(await s).toEqual({ roles: [], codes: [{ roleId: "tech_lead", code: "human-new" }] });
      await settle();
      expect(types(c)).toEqual(["set_ai_roles"]);
      expect(opened).toEqual([]);
      // reissueAll (aiRolesOf is now empty)
      await host!.forget(id); await settle();
      c.onKill = () => setImmediate(() => c.exit(null));
      const all = sup.reissueAll(id); await settle();
      void host!.attach(id, { port: 4321, aiRoles: ["tech_lead"] }); await settle();
      const c2 = children[children.length - 1]!;
      const fresh = ROLES.map((roleId) => ({ roleId, code: `fresh-${roleId}` }));
      c2.emit({ type: "codes", codes: fresh }); c2.emit({ ...READY, port: 7001 });
      await all; await settle();
      expect(c2.sent.filter((m) => m.type === "reissue")).toEqual([]);
    });

    it("(c) a legitimate bot reissue for a still-AI, certain role still works", async () => {
      const { id, c } = await setup();
      void host!.attach(id, { port: 4321, aiRoles: ["tech_lead"] }); await settle();
      expect(types(c)).toEqual(["reissue"]);
      c.emit({ type: "reissued", requestId: c.sent[0]!.requestId, code: "ai-2" }); await settle();
      expect(opened.map((o) => [o.roleId, o.code])).toEqual([["tech_lead", "ai-2"]]);
    });
  });

  it("the prompt methods take no lock (they answer while a set holds it), 404 an unknown session and refuse a role without a joined bot", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-1" }]);
    const pendingSet = sup.setAiRoles(id, []); await settle(); // holds the session lock until the child answers
    const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; } };
    expect(code(() => sup.reserveTurn(id, "tech_lead"))).toBe("ai_absent"); // answered synchronously, not queued behind the lock (the fake socket never joins)
    expect(code(() => sup.runTurn(id, "tech_lead", "0".repeat(32), "go"))).toBe("ai_expired");
    expect(() => sup.releaseTurn(id, "tech_lead", "0".repeat(32))).not.toThrow();
    expect(code(() => sup.reserveTurn("f".repeat(32), "tech_lead"))).toBe("not_found");
    c.emit({ type: "ai_roles_set", requestId: c.sent[c.sent.length - 1]!.requestId, codes: [{ roleId: "tech_lead", code: "human-1" }] });
    await pendingSet;
  });

  it("releaseTurn is a no-op for an unknown or stopped session", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    expect(() => sup.releaseTurn("f".repeat(32), "tech_lead", "0".repeat(32))).not.toThrow();
    c.exit(1); await settle();
    expect(() => sup.releaseTurn(id, "tech_lead", "0".repeat(32))).not.toThrow();
  });
});

describe("BUG-0021: a lobby's AI roles after a control-service restart (the runtime reports what fresh codes dropped)", () => {
  const FRESH = ROLES.map((roleId) => ({ roleId, code: `fresh-${roleId}` }));
  /** A control restart: a NEW Supervisor (and list reader) over the same data dir; the first one is abandoned with its child. */
  const restarted = () => { list = new SessionList(config.listFile); return make(); };
  const lastChild = (): FakeChild => children[children.length - 1]!;

  it("resumeAll: ready.aiRolesReset is re-sent with set_ai_roles, the bot gets its code, and no AI code is logged", async () => {
    const { id } = await boot(make());
    const sup2 = restarted();
    const p = sup2.resumeAll(); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7101, aiRolesReset: ["tech_lead"] }); await settle();
    expect(c2.sent.map((m) => [m.type, (m as { roles?: string[] }).roles])).toEqual([["set_ai_roles", ["tech_lead"]]]);
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-after-restart" }] });
    await p; await settle();
    expect(opened.map((o) => [o.roleId, o.code, o.port, o.closed])).toEqual([["tech_lead", "ai-after-restart", 7101, false]]);
    expect(sup2.aiRolesOf(id)).toEqual(["tech_lead"]);
    expect(reissues).toEqual([]);
    expect(logs.join("\n")).not.toContain("ai-after-restart");
  });

  it("restart of a stopped lobby after a control restart: the returned codes are the humans' only and the bot holds the AI code", async () => {
    const { id, c } = await boot(make());
    c.exit(1); await settle();
    const sup2 = restarted();
    const p = sup2.restart(id); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7102, aiRolesReset: ["tech_lead"] }); await settle();
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-tl-r" }] });
    const r = await p; await settle();
    expect(r.codes).toEqual(FRESH.filter((x) => x.roleId !== "tech_lead"));
    expect(JSON.stringify(r)).not.toContain("ai-tl-r");
    expect(JSON.stringify(r)).not.toContain("fresh-tech_lead");
    expect(opened.map((o) => [o.roleId, o.code, o.port])).toEqual([["tech_lead", "ai-tl-r", 7102]]);
  });

  it("a ready with NO codes but aiRolesReset (codes kept, seats replaced) restores the roles on resumeAll", async () => {
    const { id } = await boot(make());
    const sup2 = restarted();
    const p = sup2.resumeAll(); await settle();
    const c2 = lastChild();
    c2.emit({ ...READY, port: 7108, aiRolesReset: ["tech_lead"] }); await settle();
    expect(c2.sent.map((m) => (m as { roles?: string[] }).roles)).toEqual([["tech_lead"]]);
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-nc" }] });
    await p; await settle();
    expect(opened.map((o) => [o.roleId, o.code, o.port])).toEqual([["tech_lead", "ai-nc", 7108]]);
    expect(sup2.aiRolesOf(id)).toEqual(["tech_lead"]);
  });

  it("a ready with NO codes but aiRolesReset restores the roles on restart and returns the human codes of the re-send", async () => {
    const { id, c } = await boot(make());
    c.exit(1); await settle();
    const sup2 = restarted();
    const p = sup2.restart(id); await settle();
    const c2 = lastChild();
    c2.emit({ ...READY, port: 7109, aiRolesReset: ["tech_lead"] }); await settle();
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-nc2" }] });
    const r = await p; await settle();
    expect(JSON.stringify(r)).not.toContain("ai-nc2");
    expect(opened.map((o) => [o.roleId, o.code, o.port])).toEqual([["tech_lead", "ai-nc2", 7109]]);
  });

  it("a ready without aiRolesReset (codes kept, or no AI roles) re-sends nothing", async () => {
    await boot(make());
    const sup2 = restarted();
    const p = sup2.resumeAll(); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7103 });
    await p; await settle();
    expect(c2.sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("a started log never re-sends, even if a ready claims roles were reset (the runtime would refuse)", async () => {
    const { id } = await boot(make());
    writeFileSync(path.join(config.sessionsDir, `${id}.jsonl`), '{"type":"session.started"}\n');
    const sup2 = restarted();
    const p = sup2.resumeAll(); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7104, aiRolesReset: ["tech_lead"] });
    await p; await settle();
    expect(c2.sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("the in-memory captured set wins over ready.aiRolesReset", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    await set(sup, id, c, ["tech_lead"], [{ roleId: "tech_lead", code: "ai-old" }]);
    c.exit(1); await settle();
    const p = sup.restart(id); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7105, aiRolesReset: ["account_manager"] }); await settle();
    expect(c2.sent.map((m) => (m as { roles?: string[] }).roles)).toEqual([["tech_lead"]]);
    c2.emit({ type: "ai_roles_set", requestId: c2.sent[0]!.requestId, codes: [{ roleId: "tech_lead", code: "ai-new" }] });
    await p; await settle();
    expect(opened[opened.length - 1]!.code).toBe("ai-new");
  });

  it("an ai_notice refusal is a conflict with no codes; the roles stay human and the bot host is not half-configured", async () => {
    const { id, c } = await boot(make());
    c.exit(1); await settle();
    const sup2 = restarted();
    const p = sup2.restart(id).catch((e: Error & { code?: string }) => e); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7106, aiRolesReset: ["tech_lead"] }); await settle();
    c2.emit({ type: "ai_roles_failed", requestId: c2.sent[0]!.requestId, reason: AI_ROLES_REFUSED.notice });
    const e = await p;
    expect(e).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(e)).not.toContain("fresh-");
    await settle();
    expect(opened).toEqual([]);
    expect(sup2.aiRolesOf(id)).toEqual([]);
    expect(c2.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
  });

  it("resumeAll with an ai_notice refusal: it resolves, nothing is opened, and the failure is logged without a code", async () => {
    await boot(make());
    const sup2 = restarted();
    const p = sup2.resumeAll(); await settle();
    const c2 = lastChild();
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7107, aiRolesReset: ["tech_lead"] }); await settle();
    c2.emit({ type: "ai_roles_failed", requestId: c2.sent[0]!.requestId, reason: AI_ROLES_REFUSED.notice });
    await expect(p).resolves.toBeUndefined(); await settle();
    expect(opened).toEqual([]);
    expect(logs.join("\n")).toContain("AI roles could not be set again");
    expect(logs.join("\n")).not.toContain("fresh-");
  });
});
