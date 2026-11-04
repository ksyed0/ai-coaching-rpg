import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadScenario } from "@acr/script";
import { AI_ROLES_REFUSED } from "../../../runtime/src/host/set-ai-roles.js";
import { MAX_AI_ROLES } from "../../../runtime/src/host/limits.js";
import type { ControlConfig } from "../config.js";
import { SessionList } from "../session-list.js";
import type { BotHost } from "../bots/bot-host.js";
import { AI_REFUSALS, AI_ROLES_FAILED, ControlError, Supervisor, type BotDeps, type SetTimer, type SpawnFn } from "../supervisor.js";
import { AI_CONFIG, CODES, FakeChild, READY, flush, sid } from "./fake-child.js";

type T = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, timers: T[];
const setTimer: SetTimer = (fn, ms) => { const t: T = { fn, ms, cancelled: false, fired: false }; timers.push(t); return () => { t.cancelled = true; }; };
const pending = (ms?: number): T[] => timers.filter((t) => !t.cancelled && !t.fired && (ms === undefined || t.ms === ms));
const fire = (t: T): void => { t.fired = true; t.fn(); };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await flush(); };
const make = (extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, ...extra,
});
const boot = async (sup: Supervisor, ready: Record<string, unknown> = READY): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other");
  await settle();
  const c = children[children.length - 1]!;
  c.emit({ type: "codes", codes: CODES }); c.emit(ready);
  const r = await p;
  return { id: r.sessionId, c };
};
const errOf = (p: Promise<unknown>): Promise<ControlError> => p.then(() => { throw new Error("expected a rejection"); }, (e: ControlError) => e);
const NEW_CODES = [{ roleId: "cfo", code: "ai-cfo-1" }];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-airoles-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 777, readyTimeoutMs: 5000, ...AI_CONFIG,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; timers = [];
  spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); writeFileSync(logFile, "log"); children.push(c); return c; };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Supervisor.setAiRoles", () => {
  it("setAiRoles sends set_ai_roles with a fresh requestId and returns the human codes of the matching ai_roles_set only", async () => {
    const sup = make();
    const { id, c } = await boot(sup, { ...READY, aiRoles: ["cto"] });
    const p = sup.setAiRoles(id, ["cfo"]);
    await settle();
    expect(c.sent).toHaveLength(1);
    const m = c.sent[0]!;
    expect(m).toMatchObject({ type: "set_ai_roles", roles: ["cfo"] });
    expect(m.requestId).toMatch(/^[0-9a-f]{16}$/);
    c.emit({ type: "ai_roles_set", requestId: "0".repeat(16), codes: [{ roleId: "cto", code: "WRONG" }] });
    c.emit({ type: "ai_roles_set", requestId: m.requestId, codes: [{ roleId: "cto", code: "HUMAN-CTO" }] });
    await expect(p).resolves.toEqual({ roles: ["cfo"], codes: [{ roleId: "cto", code: "HUMAN-CTO" }] });
    expect(pending()).toEqual([]);
    await expect(sup.setAiRoles(sid(9), [])).rejects.toMatchObject({ code: "not_found" });
  });

  it("an unknown ai_roles_failed reason is a conflict with the fixed text, never the runtime's string", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const p = errOf(sup.setAiRoles(id, ["cfo"]));
    await settle();
    c.emit({ type: "ai_roles_failed", requestId: c.sent[0]!.requestId, reason: "the session has started" });
    expect(await p).toMatchObject({ code: "conflict", message: "the AI roles could not be changed" });
    expect(pending()).toEqual([]);
  });

  it("a reply with another requestId or from an earlier child is ignored", async () => {
    const sup = make();
    const { id, c: first } = await boot(sup);
    first.exit(1);
    await settle();
    const p = sup.restart(id);
    await settle();
    const c = children[children.length - 1]!;
    c.emit({ ...READY, aiRoles: ["cto"] });
    await p;
    expect(c).not.toBe(first);
    const s = sup.setAiRoles(id, ["cfo"]);
    await settle();
    const rid = c.sent[0]!.requestId;
    first.emit({ type: "ai_roles_set", requestId: rid, codes: [{ roleId: "cto", code: "STALE" }] });
    c.emit({ type: "ai_roles_failed", requestId: "1".repeat(16), reason: "other" });
    c.emit({ type: "ai_roles_set", requestId: rid, codes: [{ roleId: "cto", code: "HUMAN-CTO" }] });
    await expect(s).resolves.toEqual({ roles: ["cfo"], codes: [{ roleId: "cto", code: "HUMAN-CTO" }] });
  });

  it("the timeout rejects with timeout and a late reply changes nothing", async () => {
    const sup = make({ reissueTimeoutMs: 42 });
    const { id, c } = await boot(sup);
    const p = errOf(sup.setAiRoles(id, ["cfo"]));
    await settle();
    const t = pending(42);
    expect(t).toHaveLength(1);
    fire(t[0]!);
    expect(await p).toMatchObject({ code: "timeout", message: "the AI roles may or may not have changed; reissue the changed roles" });
    c.emit({ type: "ai_roles_set", requestId: c.sent[0]!.requestId, codes: NEW_CODES });
    await settle();
    expect(sup.aiRolesOf(id)).toEqual([]);
    // the one-per-session slot is free again
    const again = sup.setAiRoles(id, []);
    await settle();
    expect(c.sent).toHaveLength(2);
    c.emit({ type: "ai_roles_set", requestId: c.sent[1]!.requestId, codes: [] });
    await settle();
    // B14: cfo was uncertain after the timeout and the reply did not cover it, so it is reissued now
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles", "set_ai_roles", "reissue"]);
    c.emit({ type: "reissued", requestId: c.sent[2]!.requestId, code: "HUMAN-CFO" });
    await expect(again).resolves.toEqual({ roles: [], codes: [{ roleId: "cfo", code: "HUMAN-CFO" }] });
  });

  it("a child exit rejects with unavailable", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const p = errOf(sup.setAiRoles(id, ["cfo"]));
    await settle();
    c.exit(1);
    expect(await p).toMatchObject({ code: "unavailable" });
    expect(pending()).toEqual([]);
    expect((sup as unknown as { pendingAiRoles: Map<string, unknown> }).pendingAiRoles.size).toBe(0); // the entry does not leak
    expect(await errOf(sup.setAiRoles(id, ["cfo"]))).toMatchObject({ code: "conflict", message: "the session is not running" });
  });

  it("a second call while one is pending is conflict and sends nothing", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const first = sup.setAiRoles(id, ["cfo"]);
    const second = errOf(sup.setAiRoles(id, ["cto"]));
    expect(await second).toMatchObject({ code: "conflict", message: "the AI roles are already being changed" });
    await settle();
    expect(c.sent).toHaveLength(1);
    c.emit({ type: "ai_roles_set", requestId: c.sent[0]!.requestId, codes: NEW_CODES });
    await first;
  });

  it('["tech_lead", 7] and "Tech_Lead" are bad_request and nothing is sent', async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    expect(await errOf(sup.setAiRoles(id, ["tech_lead", 7] as unknown as string[]))).toMatchObject({ code: "bad_request" });
    expect(await errOf(sup.setAiRoles(id, ["Tech_Lead"]))).toMatchObject({ code: "bad_request" });
    await settle();
    expect(c.sent).toEqual([]);
  });

  it("aiRolesOf follows ready.aiRoles and a successful set, a failed set leaves it, and a later ready without aiRoles resets it to []", async () => {
    const sup = make();
    expect(sup.aiRolesOf(sid(9))).toEqual([]);
    const { id, c } = await boot(sup, { ...READY, aiRoles: ["cto"] });
    expect(sup.aiRolesOf(id)).toEqual(["cto"]);
    const bad = errOf(sup.setAiRoles(id, ["cfo"]));
    await settle();
    c.emit({ type: "ai_roles_failed", requestId: c.sent[0]!.requestId, reason: "no" });
    await bad;
    expect(sup.aiRolesOf(id)).toEqual(["cto"]);
    const ok = sup.setAiRoles(id, ["cfo", "cto"]);
    await settle();
    c.emit({ type: "ai_roles_set", requestId: c.sent[1]!.requestId, codes: [] });
    await ok;
    expect(sup.aiRolesOf(id)).toEqual(["cfo", "cto"]);
    c.exit(1);
    await settle();
    const r = sup.restart(id);
    await settle();
    children[children.length - 1]!.emit(READY);
    await r;
    expect(sup.aiRolesOf(id)).toEqual([]);
  });
});

type BotCall = { op: "attach" | "setCodes" | "removeRoles" | "forget"; id: string; arg: unknown };
let botCalls: BotCall[], logs: string[], setCodesImpl: () => Promise<void>, removeImpl: () => Promise<void>;
const fakeBots = (): BotHost => ({
  forget: (id: string) => { botCalls.push({ op: "forget", id, arg: undefined }); return Promise.resolve(); },
  attach: (id: string, arg: unknown) => { botCalls.push({ op: "attach", id, arg }); return setCodesImpl(); }, end: async () => {}, detach: async () => {}, close: async () => {},
  setCodes: (id: string, arg: unknown) => { botCalls.push({ op: "setCodes", id, arg }); return setCodesImpl(); },
  removeRoles: (id: string, arg: unknown) => { botCalls.push({ op: "removeRoles", id, arg }); return removeImpl(); },
} as unknown as BotHost);
const makeB = () => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
  bots: (_d: BotDeps) => fakeBots(),
});
/** Boots with the bots wired, then forgets the goLive attach so each test sees only its own calls. */
const bootB = async (sup: Supervisor, ready: Record<string, unknown> = READY): Promise<{ id: string; c: FakeChild }> => {
  const r = await boot(sup, ready); await settle(); botCalls.length = 0; return r;
};
const reply = async (c: FakeChild, i: number, codes: { roleId: string; code: string }[]): Promise<void> => {
  c.emit({ type: "ai_roles_set", requestId: c.sent[i]!.requestId, codes }); await settle();
};

describe("Supervisor.setAiRoles with the bots (US-0060 Task 11)", () => {
  beforeEach(() => { botCalls = []; logs = []; setCodesImpl = async () => {}; removeImpl = async () => {}; });

  it("setAiRoles([cto]) returns {roles:[cto], codes:[]} and hands cto's code to the bots (one attach with codes) only", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup);
    const p = sup.setAiRoles(id, ["cto"]); await settle();
    await reply(c, 0, [{ roleId: "cto", code: "SECRET-CTO" }]);
    const r = await p;
    expect(r).toEqual({ roles: ["cto"], codes: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-CTO");
    expect(botCalls).toEqual([{ op: "attach", id, arg: { port: 4321, aiRoles: ["cto"], codes: [{ roleId: "cto", code: "SECRET-CTO" }] } }]);
    expect(sup.aiRolesOf(id)).toEqual(["cto"]);
    expect(logs.join("\n")).not.toContain("SECRET-CTO");
  });

  it("switching cto back to human returns its new human code, removes the bot, and splits a mixed reply", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup, { ...READY, aiRoles: ["cto"] });
    const p = sup.setAiRoles(id, ["cfo"]); await settle();
    await reply(c, 0, [{ roleId: "cfo", code: "AI-CFO" }, { roleId: "cto", code: "HUMAN-CTO" }]);
    expect(await p).toEqual({ roles: ["cfo"], codes: [{ roleId: "cto", code: "HUMAN-CTO" }] });
    expect(botCalls).toEqual([
      { op: "removeRoles", id, arg: ["cto"] },
      { op: "attach", id, arg: { port: 4321, aiRoles: ["cfo"], codes: [{ roleId: "cfo", code: "AI-CFO" }] } },
    ]);
    expect(sup.aiRolesOf(id)).toEqual(["cfo"]);
  });

  it("returned roles follow the scenario (create) order, not the request order", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup);
    const p = sup.setAiRoles(id, ["cto", "cfo"]); await settle();
    await reply(c, 0, []);
    expect((await p).roles).toEqual(["cfo", "cto"]);
  });

  it("the runtime's five fixed refusals map to their own codes; failed and an unknown reason stay conflict", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup);
    const cases: [string, string][] = [
      ["the consent notice in use does not mention AI players", "ai_notice"],
      ["AI roles can only be changed before the start", "ai_started"],
      ["not a player role of this session", "ai_invalid"],
      ["at least one player role must stay human", "ai_no_human"],
      ["at most 8 player roles can be AI players", "ai_too_many"],
      ["the AI roles could not be changed", "conflict"],
      ["something unexpected with /a/path", "conflict"],
    ];
    for (const [i, [reason, code]] of cases.entries()) {
      const p = errOf(sup.setAiRoles(id, ["cfo"])); await settle();
      c.emit({ type: "ai_roles_failed", requestId: c.sent[i]!.requestId, reason });
      const e = await p;
      expect(e.code).toBe(code);
      if (code !== "conflict") expect(e.message).toBe(reason);
      else expect(e.message).toBe("the AI roles could not be changed");
    }
    expect(sup.aiRolesOf(id)).toEqual([]);
    expect(botCalls).toEqual([]);
  });

  it("reissue and remove of an AI role are ai_role and send nothing; a human role is reissued as before", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup, { ...READY, aiRoles: ["cfo"] });
    const r1 = errOf(sup.reissue(id, "cfo"));
    await settle();
    expect(c.sent).toEqual([]); // refused before anything is sent (a late refusal would have sent a reissue first)
    expect(await r1).toMatchObject({ code: "ai_role", message: "switch the role back to human first" });
    const r2 = errOf(sup.reissue(id, "cfo", "fac", "removed"));
    await settle();
    expect(c.sent).toEqual([]);
    expect(await r2).toMatchObject({ code: "ai_role" });
    const p = sup.reissue(id, "cto"); await settle();
    expect(c.sent.map((m) => m.type)).toEqual(["reissue"]);
    c.emit({ type: "reissued", requestId: c.sent[0]!.requestId, code: "NEW" });
    await expect(p).resolves.toBe("NEW");
  });

  it("a reissue queued behind a setAiRoles that makes the role AI is refused ai_role and sends nothing", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup);
    const set = sup.setAiRoles(id, ["cfo"]); await settle();
    const re = errOf(sup.reissue(id, "cfo")); await settle();
    await reply(c, 0, [{ roleId: "cfo", code: "X" }]);
    await set;
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
    expect(await re).toMatchObject({ code: "ai_role" });
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
  });

  it("setAiRoles resolves while a BotHost.attach and removeRoles never resolve (not awaited under the lock)", async () => {
    setCodesImpl = () => new Promise<void>(() => {});
    removeImpl = () => new Promise<void>(() => {});
    const sup = makeB();
    const { id, c } = await bootB(sup, { ...READY, aiRoles: ["cto"] });
    const p = sup.setAiRoles(id, ["cfo"]); await settle();
    await reply(c, 0, [{ roleId: "cfo", code: "A" }, { roleId: "cto", code: "H" }]);
    await expect(p).resolves.toEqual({ roles: ["cfo"], codes: [{ roleId: "cto", code: "H" }] });
    // the lock is free again
    const q = sup.setAiRoles(id, ["cfo"]); await settle();
    await reply(c, 1, []);
    await expect(q).resolves.toEqual({ roles: ["cfo"], codes: [] });
  });

  it("a rejecting attach or removeRoles is logged by error name only, never with a code", async () => {
    setCodesImpl = () => Promise.reject(new Error("boom SECRET-CODE"));
    removeImpl = () => Promise.reject(new TypeError("boom SECRET-CODE"));
    const sup = makeB();
    const { id, c } = await bootB(sup, { ...READY, aiRoles: ["cto"] });
    const p = sup.setAiRoles(id, ["cfo"]); await settle();
    await reply(c, 0, [{ roleId: "cfo", code: "SECRET-CODE" }, { roleId: "cto", code: "H" }]);
    await p; await settle();
    const log = logs.join("\n");
    expect(log).toContain("Error");
    expect(log).toContain("TypeError");
    expect(log).not.toContain("SECRET-CODE");
  });

  it("no ControlError message carries a code, and the create result has no role of aiRolesOf", async () => {
    const sup = makeB();
    const p = sup.create("other"); await settle();
    const c0 = children[children.length - 1]!;
    c0.emit({ type: "codes", codes: CODES }); c0.emit(READY);
    const created = await p;
    expect(sup.aiRolesOf(created.sessionId)).toEqual([]);
    expect(created.codes.map((x) => x.roleId).filter((r) => sup.aiRolesOf(created.sessionId).includes(r))).toEqual([]);
    const c = children[children.length - 1]!;
    const msgs: string[] = [];
    const bad = errOf(sup.setAiRoles(created.sessionId, ["cfo"])); await settle();
    c.emit({ type: "ai_roles_failed", requestId: c.sent[0]!.requestId, reason: "at most 8 player roles can be AI players ai-cfo-1" });
    msgs.push((await bad).message);
    msgs.push((await errOf(sup.reissue(created.sessionId, "Bad Role"))).message);
    const ok = sup.setAiRoles(created.sessionId, ["cfo"]); await settle();
    await reply(c, 1, [{ roleId: "cfo", code: "ai-cfo-1" }]); await ok;
    msgs.push((await errOf(sup.reissue(created.sessionId, "cfo"))).message);
    for (const m of msgs) expect(m).not.toContain("ai-cfo-1");
    expect(logs.join("\n")).not.toContain("ai-cfo-1");
  });

  it("after a refused change (ai_started) an AI role is still refused ai_role for reissue and remove, and a human role still reissues", async () => {
    const sup = makeB();
    const { id, c } = await bootB(sup, { ...READY, aiRoles: ["cfo"] });
    const bad = errOf(sup.setAiRoles(id, [])); await settle();
    c.emit({ type: "ai_roles_failed", requestId: c.sent[0]!.requestId, reason: AI_ROLES_REFUSED.started });
    expect(await bad).toMatchObject({ code: "ai_started" });
    for (const reason of [undefined, "removed" as const]) {
      const r = errOf(sup.reissue(id, "cfo", "fac", reason)); await settle();
      expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
      expect(await r).toMatchObject({ code: "ai_role" });
    }
    const ok = sup.reissue(id, "cto", "fac", "removed"); await settle();
    expect(c.sent.map((m) => m.type)).toEqual(["set_ai_roles", "reissue"]);
    c.emit({ type: "reissued", requestId: c.sent[1]!.requestId, code: "N" });
    await expect(ok).resolves.toBe("N");
  });

  it("the roles come back in scenario order after a control restart (no create codes in memory)", async () => {
    const scen = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios");
    const players = Object.values((await loadScenario(path.join(scen, "friday-escalation"))).roles).filter((r) => r.type === "player").map((r) => r.id);
    expect(players.length).toBeGreaterThan(2);
    const id = sid(77);
    list.upsert({ sessionId: id, scenarioId: "friday-escalation", status: "stopped" });
    const sup = new Supervisor({ config: { ...config, scenariosDir: scen }, list, scenarios: async () => [{ id: "friday-escalation", title: "F" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m) });
    const rp = sup.restart(id); await settle();
    const c = children[children.length - 1]!;
    c.emit(READY); await rp;
    const wanted = [players[2]!, players[0]!];
    const p = sup.setAiRoles(id, wanted);
    for (let i = 0; i < 100 && c.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5)); // the scenario file is read first
    await reply(c, 0, []);
    expect((await p).roles).toEqual([players[0], players[2]]);
  });
});

describe("the supervisor's AI refusal map matches the runtime's", () => {
  it("has exactly the runtime's fixed reasons except failed, which stays the generic conflict text", () => {
    const { failed, ...rest } = AI_ROLES_REFUSED;
    expect([...AI_REFUSALS.keys()].sort()).toEqual(Object.values(rest).sort());
    expect(AI_ROLES_FAILED).toBe(failed);
    expect(AI_REFUSALS.get(AI_ROLES_REFUSED.tooMany)).toBe("ai_too_many");
    expect(AI_ROLES_REFUSED.tooMany).toContain(`at most ${MAX_AI_ROLES} `);
  });
});

/** A promise that must settle soon: a self-wait (deadlock) fails in a second, not after the 60 s test timeout. */
const bounded = <T,>(p: Promise<T>, ms = 1500): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("hung: did not settle")), ms))]);
const FRESH = [{ roleId: "tech_lead", code: "fresh-tl" }, { roleId: "account_manager", code: "fresh-am" }, { roleId: "delivery_lead", code: "fresh-dl" }];
const HUMAN = [{ roleId: "account_manager", code: "fresh-am" }, { roleId: "delivery_lead", code: "fresh-dl" }];
const READY3 = { ...READY, aiRoles: ["tech_lead"] };
const bootT = async (sup: Supervisor, ready: Record<string, unknown> = READY3): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other"); await settle();
  const c = children[children.length - 1]!;
  c.emit({ type: "codes", codes: FRESH }); c.emit(ready);
  const r = await p; await settle(); botCalls.length = 0;
  return { id: r.sessionId, c };
};
const dies = (c: FakeChild): void => { c.onKill = () => setImmediate(() => c.exit(null)); };
const lastAttach = (): { port: number; aiRoles: string[]; codes?: { roleId: string; code: string }[] } =>
  [...botCalls].reverse().find((x) => x.op === "attach")!.arg as { port: number; aiRoles: string[]; codes?: { roleId: string; code: string }[] };

describe("whole-session reissue, restart, resume and timeout recovery (Task 12)", () => {
  beforeEach(() => { botCalls = []; logs = []; setCodesImpl = async () => {}; removeImpl = async () => {}; });

  it("reissueAll with tech_lead AI resolves (no self-wait): the child gets set_ai_roles [tech_lead] after ready, the reply has the human codes only, and the bots get tech_lead's code", async () => {
    const sup = makeB();
    const { id, c } = await bootT(sup);
    dies(c);
    const p = sup.reissueAll(id); await settle();
    const c2 = children[1]!;
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7001 }); await settle();
    expect(c2.sent.map((m) => [m.type, (m as { roles?: string[] }).roles])).toEqual([["set_ai_roles", ["tech_lead"]]]);
    await reply(c2, 0, [{ roleId: "tech_lead", code: "ai-tl" }]);
    const r = await bounded(p);
    expect(r).toEqual(HUMAN);
    expect(JSON.stringify(r)).not.toContain("ai-tl");
    expect(botCalls.some((x) => x.op === "forget" && x.id === id)).toBe(true);
    expect(lastAttach()).toEqual({ port: 7001, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "ai-tl" }] });
    expect(sup.aiRolesOf(id)).toEqual(["tech_lead"]);
    expect(logs.join("\n")).not.toMatch(/ai-tl|fresh-/);
  });

  it("reissueAll when the re-send fails returns no code and rejects conflict", async () => {
    const sup = makeB();
    const { id, c } = await bootT(sup);
    dies(c);
    const p = errOf(sup.reissueAll(id)); await settle();
    const c2 = children[1]!;
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7001 }); await settle();
    c2.emit({ type: "ai_roles_failed", requestId: c2.sent[0]!.requestId, reason: "AI roles can only be changed before the start" });
    const e = await bounded(p);
    expect(e).toMatchObject({ code: "conflict", message: "the codes were reissued but the AI roles could not be set again; set them again" });
    expect(e.message).not.toMatch(/fresh-/);
  });

  it("a restart of an empty lobby that issued codes re-sends set_ai_roles and returns no AI code", async () => {
    const sup = makeB();
    const { id, c } = await bootT(sup);
    c.exit(1); await settle();
    const p = sup.restart(id); await settle();
    const c2 = children[1]!;
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7002 }); await settle();
    expect(c2.sent.map((m) => m.type)).toEqual(["set_ai_roles"]);
    await reply(c2, 0, [{ roleId: "tech_lead", code: "ai-tl" }]);
    const r = await bounded(p);
    expect(r.codes).toEqual(HUMAN);
    expect(lastAttach().codes).toEqual([{ roleId: "tech_lead", code: "ai-tl" }]);
  });

  it("a restart of a started session that issued codes sends no set_ai_roles and returns only human codes (AI codes by ready.aiRoles go to the bots)", async () => {
    const sup = makeB();
    const { id, c } = await bootT(sup);
    c.exit(1); await settle();
    writeFileSync(path.join(config.sessionsDir, `${id}.jsonl`), '{"type":"session.started"}\n');
    const p = sup.restart(id); await settle();
    const c2 = children[1]!;
    c2.emit({ type: "codes", codes: FRESH }); c2.emit({ ...READY, port: 7003, aiRoles: ["tech_lead"] });
    const r = await bounded(p);
    expect(c2.sent).toEqual([]);
    expect(r.codes).toEqual(HUMAN);
    expect(lastAttach()).toMatchObject({ port: 7003, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "fresh-tl" }] });
  });

  it("resumeAll with an AI role resolves and returns nothing", async () => {
    const sup = makeB();
    await bootT(sup);
    const sup2 = makeB();
    const p = sup2.resumeAll(); await settle();
    const c2 = children[1]!;
    c2.emit({ ...READY, port: 7004, aiRoles: ["tech_lead"] });
    await expect(bounded(p)).resolves.toBeUndefined();
    expect(sup2.aiRolesOf([...list.read()][0]!.sessionId)).toEqual(["tech_lead"]);
  });

  it("after a set timeout, reissue of an uncertain role is ai_role; the next setAiRoles sends the wanted set, then reissues each uncertain role the reply did not carry, and returns only human codes", async () => {
    const sup = makeB();
    const { id, c } = await bootT(sup, READY);
    const first = errOf(sup.setAiRoles(id, ["tech_lead"])); await settle();
    const t = timers.find((x) => !x.cancelled && !x.fired && x.ms === 60_000) ?? timers.filter((x) => !x.cancelled && !x.fired)[0]!;
    fire(t);
    expect(await first).toMatchObject({ code: "timeout" });
    const before = c.sent.length;
    for (const reason of [undefined, "removed" as const]) {
      const r = errOf(sup.reissue(id, "tech_lead", "fac", reason)); await settle();
      expect(c.sent.length).toBe(before);
      expect(await r).toMatchObject({ code: "ai_role" });
    }
    const p = sup.setAiRoles(id, ["account_manager"]); await settle();
    expect(c.sent[before]).toMatchObject({ type: "set_ai_roles", roles: ["account_manager"] });
    c.emit({ type: "ai_roles_set", requestId: c.sent[before]!.requestId, codes: [{ roleId: "account_manager", code: "ai-am" }] }); await settle();
    expect(c.sent[before + 1]).toMatchObject({ type: "reissue", roleId: "tech_lead" });
    c.emit({ type: "reissued", requestId: c.sent[before + 1]!.requestId, code: "human-tl" });
    const r = await bounded(p);
    expect(r).toEqual({ roles: ["account_manager"], codes: [{ roleId: "tech_lead", code: "human-tl" }] });
    expect(lastAttach().codes).toEqual([{ roleId: "account_manager", code: "ai-am" }]);
    // no longer uncertain: a single reissue goes through again
    const again = sup.reissue(id, "tech_lead"); await settle();
    expect(c.sent[before + 2]).toMatchObject({ type: "reissue", roleId: "tech_lead" });
    c.emit({ type: "reissued", requestId: c.sent[before + 2]!.requestId, code: "x" });
    await expect(again).resolves.toBe("x");
  });

  it("a create rollback deletes the session's intent files (bots.forget)", async () => {
    const sup = makeB();
    const p = errOf(sup.create("other")); await settle();
    children[children.length - 1]!.exit(1);
    await bounded(p);
    await settle();
    expect(botCalls.filter((x) => x.op === "forget")).toHaveLength(1);
  });
});
