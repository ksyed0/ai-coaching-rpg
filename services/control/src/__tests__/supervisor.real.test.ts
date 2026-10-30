import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadControlConfig, type ControlConfig } from "../config.js";
import { listScenarios } from "../scenarios.js";
import { SessionList } from "../session-list.js";
import { forkSpawn } from "../spawn.js";
import { ControlError, Supervisor } from "../supervisor.js";

/**
 * REAL runtime children (services/runtime, mock provider), a temp CONTROL_DATA_DIR so nothing is written under the repository, and the
 * real forkSpawn. Slow by nature: every wait is a poll with a deadline, never a fixed sleep.
 */
const ROLES = ["account_manager", "delivery_lead", "tech_lead"];
const DEADLINE_MS = 45_000;
const SCENARIO = "friday-escalation";

let root: string;
let config: ControlConfig;
const supervisors: Supervisor[] = [];
/** Pids of every child forked, in order (the handle carries it for tests and diagnostics). */
let pids: number[] = [];
/** How often the service had to signal a child (the disconnect path needs neither). */
let signals = { kill: 0, forceKill: 0 };

/** The environment the service would hold: no HOME, nothing but what the child allowlist copies. */
const parentEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, MODEL_PROVIDER: "mock" });

function makeSupervisor(): Supervisor {
  const sup = new Supervisor({
    config, list: new SessionList(config.listFile), scenarios: () => listScenarios(config.scenariosDir), spawn: (o) => {
      const h = forkSpawn()(o);
      pids.push((h as unknown as { pid: number }).pid);
      const { kill, forceKill } = h;
      h.kill = () => { signals.kill++; kill(); };
      h.forceKill = () => { signals.forceKill++; forceKill(); };
      return h;
    }, parentEnv: parentEnv(),
  });
  supervisors.push(sup);
  return sup;
}

async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + DEADLINE_MS;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Joins as a player with the join protocol and resolves to the first answer's type (and error code). */
function join(port: number, sessionId: string, roleId: string, joinCode: string): Promise<{ type: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("join timed out")); }, 20_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", sessionId, roleId, participantId: `p-${randomBytes(4).toString("hex")}`, joinCode })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; code?: string };
      if (m.type === "joined" || m.type === "error") { clearTimeout(timer); ws.close(); resolve({ type: m.type, ...(m.code ? { code: m.code } : {}) }); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

beforeEach(() => {
  pids = [];
  signals = { kill: 0, forceKill: 0 };
  root = mkdtempSync(path.join(tmpdir(), "acr-real-"));
  config = loadControlConfig({
    CONTROL_DATA_DIR: root, LAUNCHER_TOKEN: "r".repeat(40), CONTROL_GRACE_MS: "10000", CONTROL_READY_TIMEOUT_MS: "40000", MAX_SESSIONS: "5",
  });
});
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.shutdown().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("Supervisor with real runtime children", () => {
  it("create returns the issued codes for every player role of friday-escalation and ready arrives with a port", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    expect(r.status).toBe("running");
    expect(r.port).toBeGreaterThan(0);
    expect(r.modelLabel.length).toBeGreaterThan(0);
    expect(r.codes.map((c) => c.roleId).sort()).toEqual(ROLES);
    for (const c of r.codes) expect(c.code.length).toBeGreaterThan(0);
    expect(sup.facilitator(r.sessionId)).toMatchObject({ port: r.port });
    expect(sup.get(r.sessionId)?.status).toBe("running");
  });

  it("the child log file is mode 0600 and in a 0700 directory, and holds no code or token", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    const logFile = path.join(config.logDir, `${r.sessionId}.log`);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(statSync(config.logDir).mode & 0o777).toBe(0o700);
    const text = readFileSync(logFile, "utf8");
    for (const c of r.codes) expect(text).not.toContain(c.code);
    expect(text).not.toContain(sup.facilitator(r.sessionId)!.token);
  });

  it("the child exits when the service disconnects (shutdown)", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    await sup.shutdown(); // resolves only when every child has exited (or the grace period passed)
    // The exit came from the disconnect: neither kill (SIGTERM) nor the force-kill backstop was needed.
    expect(signals).toEqual({ kill: 0, forceKill: 0 });
    expect(pids.length).toBe(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow(); // the process is gone
    // The port no longer answers.
    await expect(join(r.port, r.sessionId, ROLES[0]!, "x")).rejects.toThrow();
  });

  it("a SIGKILLed child becomes stopped and restart resumes it", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    const pid = pids.at(-1)!;
    process.kill(pid, "SIGKILL");
    await until("stopped", () => sup.get(r.sessionId)?.status === "stopped");
    expect(sup.facilitator(r.sessionId)).toBeUndefined();
    const again = await sup.restart(r.sessionId);
    expect(again.status).toBe("running");
    expect(again.port).toBeGreaterThan(0);
    expect(again.codes).toBeUndefined(); // a resume does not show codes again
    expect(sup.facilitator(r.sessionId)).toMatchObject({ port: again.port });
  });

  it("a lobby survives a control-service restart: a second Supervisor resumeAll()s it, no codes are re-shown and an old code still verifies", async () => {
    const first = makeSupervisor();
    const r = await first.create(SCENARIO);
    const code = r.codes.find((c) => c.roleId === "tech_lead")!.code;
    await first.shutdown(); // the first service goes away; its children exit on the disconnect

    const second = makeSupervisor();
    await second.resumeAll();
    const info = second.get(r.sessionId)!;
    expect(info.status).toBe("running");
    expect(info.port).toBeGreaterThan(0);
    expect(second.list().map((s) => s.sessionId)).toEqual([r.sessionId]);
    const answer = await join(info.port!, r.sessionId, "tech_lead", code);
    expect(answer.type).toBe("joined");
    const wrong = await join(info.port!, r.sessionId, "delivery_lead", "not-a-real-code");
    expect(wrong.type).toBe("error");
  });

  it("reissue over IPC returns a new code and the old code is refused", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    const old = r.codes.find((c) => c.roleId === "delivery_lead")!.code;
    const fresh = await sup.reissue(r.sessionId, "delivery_lead", "Test Facilitator");
    expect(fresh).not.toBe(old);
    expect((await join(r.port, r.sessionId, "delivery_lead", old)).type).toBe("error");
    expect((await join(r.port, r.sessionId, "delivery_lead", fresh)).type).toBe("joined");
  });

  it("reissueAll before the start returns a full new set", async () => {
    const sup = makeSupervisor();
    const r = await sup.create(SCENARIO);
    const fresh = await sup.reissueAll(r.sessionId, "Test Facilitator");
    expect(fresh.map((c) => c.roleId).sort()).toEqual(ROLES);
    const info = sup.get(r.sessionId)!;
    expect(info.status).toBe("running");
    const oldByRole = new Map(r.codes.map((c) => [c.roleId, c.code]));
    for (const c of fresh) expect(c.code).not.toBe(oldByRole.get(c.roleId));
    const oldCode = oldByRole.get("account_manager")!;
    const newCode = fresh.find((c) => c.roleId === "account_manager")!.code;
    expect((await join(info.port!, r.sessionId, "account_manager", oldCode)).type).toBe("error");
    expect((await join(info.port!, r.sessionId, "account_manager", newCode)).type).toBe("joined");
  });

  it("a scenario outside the allowlist is refused before any child is started", async () => {
    const sup = makeSupervisor();
    const err = await sup.create("../x").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("unknown_scenario");
  });
});
