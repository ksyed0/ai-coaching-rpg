import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlConfig } from "../config.js";
import { SessionList } from "../session-list.js";
import { ControlError, Supervisor, type SetTimer, type SpawnFn } from "../supervisor.js";
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
  it("setAiRoles sends set_ai_roles with a fresh requestId and resolves with the codes of the matching ai_roles_set", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const p = sup.setAiRoles(id, ["cfo"]);
    await settle();
    expect(c.sent).toHaveLength(1);
    const m = c.sent[0]!;
    expect(m).toMatchObject({ type: "set_ai_roles", roles: ["cfo"] });
    expect(m.requestId).toMatch(/^[0-9a-f]{16}$/);
    c.emit({ type: "ai_roles_set", requestId: "0".repeat(16), codes: [{ roleId: "cfo", code: "WRONG" }] });
    c.emit({ type: "ai_roles_set", requestId: m.requestId, codes: NEW_CODES });
    await expect(p).resolves.toEqual(NEW_CODES);
    expect(pending()).toEqual([]);
    await expect(sup.setAiRoles(sid(9), [])).rejects.toMatchObject({ code: "not_found" });
  });

  it("ai_roles_failed is a conflict carrying the runtime's reason", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const p = errOf(sup.setAiRoles(id, ["cfo"]));
    await settle();
    c.emit({ type: "ai_roles_failed", requestId: c.sent[0]!.requestId, reason: "the session has started" });
    expect(await p).toMatchObject({ code: "conflict", message: "the session has started" });
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
    c.emit(READY);
    await p;
    expect(c).not.toBe(first);
    const s = sup.setAiRoles(id, ["cfo"]);
    await settle();
    const rid = c.sent[0]!.requestId;
    first.emit({ type: "ai_roles_set", requestId: rid, codes: [{ roleId: "cfo", code: "STALE" }] });
    c.emit({ type: "ai_roles_failed", requestId: "1".repeat(16), reason: "other" });
    c.emit({ type: "ai_roles_set", requestId: rid, codes: NEW_CODES });
    await expect(s).resolves.toEqual(NEW_CODES);
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
    await expect(again).resolves.toEqual([]);
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
    c.emit({ type: "ai_roles_set", requestId: c.sent[1]!.requestId, codes: NEW_CODES });
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
