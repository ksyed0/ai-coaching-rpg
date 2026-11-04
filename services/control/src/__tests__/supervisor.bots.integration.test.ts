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
import { AI_CONFIG, FakeChild, READY, flush } from "./fake-child.js";

/** The Supervisor with a REAL BotHost (only the socket factory is fake): what a role switched to AI after the session went live really does. */
const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios/friday-escalation");
const ROLES = ["delivery_lead", "tech_lead", "account_manager"];
const CODES = ROLES.map((roleId) => ({ roleId, code: `human-${roleId}` }));

let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], spawn: SpawnFn, scenario: Scenario;
let opened: { roleId: string; code: string; port: number; closed: boolean }[], reissues: string[], logs: string[], host: BotHost | undefined;
const setTimer: SetTimer = () => () => undefined;
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await flush(); };
const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  const rec = { roleId: o.roleId, code: o.code, port: o.port, closed: false };
  opened.push(rec);
  return { say: () => undefined, close: async () => { rec.closed = true; } } as unknown as BotSocket;
};

const make = () => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
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
  children = []; opened = []; reissues = []; logs = []; host = undefined;
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
});
