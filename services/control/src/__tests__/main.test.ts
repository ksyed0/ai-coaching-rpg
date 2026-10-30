import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startControl, type RunningControl } from "../main.js";
import { SessionList } from "../session-list.js";
import type { SpawnFn } from "../supervisor.js";
import { FakeChild, READY, sid } from "./fake-child.js";

const TOKEN = "k".repeat(40);
let root: string;
let env: NodeJS.ProcessEnv;
let running: RunningControl | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-main-"));
  mkdirSync(path.join(root, "scenarios", "friday-escalation"), { recursive: true });
  env = { CONTROL_DATA_DIR: path.join(root, "data"), LAUNCHER_TOKEN: TOKEN, SCENARIOS_DIR: path.join(root, "scenarios"), CONTROL_GRACE_MS: "200" };
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A fake runtime that says ready at once and exits when the service disconnects or kills it. */
const mortal = (c: FakeChild): FakeChild => {
  c.disconnect = () => { c.disconnected++; setImmediate(() => c.exit(0)); };
  c.onKill = () => setImmediate(() => c.exit(null));
  setImmediate(() => c.emit(READY));
  return c;
};

const get = (port: number, p: string, token: string | null = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: token === null ? {} : { "x-service-token": token } });

describe("startControl", () => {
  it("warns when CONTROL_READY_TIMEOUT_MS + 2 * CONTROL_GRACE_MS exceeds what the web server waits, and stays quiet otherwise", async () => {
    const logs: string[] = [];
    running = await startControl({ ...env, CONTROL_READY_TIMEOUT_MS: "100000", CONTROL_GRACE_MS: "10000" }, { port: 0, log: (m) => logs.push(m) });
    expect(logs.filter((l) => l.startsWith("warning: CONTROL_READY_TIMEOUT_MS"))).toHaveLength(1);
    expect(logs.join("\n")).toContain("120000 ms");
    expect(logs.join("\n")).not.toContain(TOKEN);
    await running.close();
    logs.length = 0;
    running = await startControl({ ...env, CONTROL_READY_TIMEOUT_MS: "90000", CONTROL_GRACE_MS: "10000" }, { port: 0, log: (m) => logs.push(m) });
    expect(logs.filter((l) => l.includes("CONTROL_READY_TIMEOUT_MS"))).toEqual([]);
  });

  it("listens on loopback, answers with the token only and close() stops it", async () => {
    const logs: string[] = [];
    running = await startControl(env, { port: 0, log: (m) => logs.push(m) });
    expect(running.port).toBeGreaterThan(0);
    expect((await get(running.port, "/scenarios", null)).status).toBe(401);
    const ok = await get(running.port, "/scenarios");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, data: [], error: null }); // the empty fixture folder is not a scenario
    expect(logs.join("\n")).toContain("scenario folder skipped: friday-escalation");
    expect(logs.join("\n")).not.toContain(TOKEN);
    const { port } = running;
    await running.close();
    await running.close(); // idempotent
    running = undefined;
    await expect(get(port, "/scenarios")).rejects.toThrow();
  });

  it("refuses a bad configuration with one plain message that names the variables but no values", async () => {
    const bad = { CONTROL_DATA_DIR: "relative/secret-looking", LAUNCHER_TOKEN: "short-token-value", CONTROL_PORT: "99999" };
    const err = await startControl(bad, { port: 0 }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("CONTROL_DATA_DIR");
    expect(err!.message).toContain("LAUNCHER_TOKEN");
    expect(err!.message).toContain("CONTROL_PORT");
    expect(err!.message).not.toContain("secret-looking");
    expect(err!.message).not.toContain("short-token-value");
  });

  it("refuses a port that is already taken and stops the sessions it resumed", async () => {
    running = await startControl(env, { port: 0 });
    const taken = running.port;
    const children: FakeChild[] = [];
    const spawn: SpawnFn = ({ env: e, logFile }) => { const c = mortal(new FakeChild(e, logFile)); children.push(c); return c; };
    // a resumable session in a second data dir
    const other = { ...env, CONTROL_DATA_DIR: path.join(root, "data2") };
    mkdirSync(path.join(other.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(other.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(1), scenarioId: "friday-escalation", status: "running" });
    const err = await startControl(other, { port: taken, spawn }).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`cannot listen on 127.0.0.1:${taken} (EADDRINUSE)`);
    expect(children).toHaveLength(1);
    expect(children[0]!.disconnected).toBeGreaterThan(0); // shutdown() disconnects, it does not leave the child running
  });

  it("resumes existing sessions before it listens and disconnects their children on close", async () => {
    mkdirSync(path.join(env.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(2), scenarioId: "friday-escalation", status: "running" });
    const children: FakeChild[] = [];
    const spawn: SpawnFn = ({ env: e, logFile }) => {
      const c = mortal(new FakeChild(e, logFile));
      children.push(c);
      return c;
    };
    running = await startControl(env, { port: 0, spawn });
    expect(children).toHaveLength(1); // already running before the first request could be answered
    expect(children[0]!.env.SESSION_START).toBe("resume");
    const info = await (await get(running.port, `/sessions/${sid(2)}`)).json() as { data: { status: string; port: number } };
    expect(info.data.status).toBe("running");
    await running.close();
    running = undefined;
    expect(children[0]!.disconnected).toBeGreaterThan(0);
    // an orderly shutdown is not a crash: the list still says running and nothing is logged as unexpected
    const listed = new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).read();
    expect(listed.map((e) => e.status)).toEqual(["running"]);
  });

  it("passes the merged environment (including values read from .env) to the allowlist, not process.env", async () => {
    const spawned: NodeJS.ProcessEnv[] = [];
    mkdirSync(path.join(env.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(3), scenarioId: "friday-escalation", status: "running" });
    const spawn: SpawnFn = ({ env: e, logFile }) => { spawned.push(e); return mortal(new FakeChild(e, logFile)); };
    running = await startControl({ ...env, MODEL_PROVIDER: "mock", GM_MODEL: "from-dotenv" }, { port: 0, spawn });
    expect(spawned[0]!.MODEL_PROVIDER).toBe("mock");
    expect(spawned[0]!.GM_MODEL).toBe("from-dotenv");
    expect(spawned[0]!.LAUNCHER_TOKEN).toBeUndefined();
  });
});
