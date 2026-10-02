import { describe, expect, it, afterEach } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootstrap, type Runtime } from "../main.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null;
afterEach(async () => { await runtime?.stop(); runtime = null; if (tmp) await rm(tmp, { recursive: true, force: true }); });

describe("bootstrap", () => {
  it("starts the runtime with the mock provider on an ephemeral port and serves a facilitator join", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const logs: string[] = [];
    const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "t1", ANTHROPIC_API_KEY: "sk-secret-123" }, logDir: tmp, tickMs: 50, log: (m) => logs.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(runtime.port).toBeGreaterThan(0);
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}`);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "join_facilitator", sessionId: "t1" })));
      ws.on("message", (d) => resolve(JSON.parse(d.toString())));
      ws.on("error", reject);
    });
    ws.close();
    expect(msg).toMatchObject({ type: "joined", roleId: "facilitator" });
    expect(logs.join("\n")).toMatch(/Minimal/);
    expect(logs.join("\n")).not.toMatch(/sk-secret-123/);
  });

  it("reports validation errors and starts nothing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const bad = path.join(tmp, "bad");
    await cp(fixture, bad, { recursive: true });
    const scriptFile = path.join(bad, "script.yaml");
    await writeFile(scriptFile, (await readFile(scriptFile, "utf8")).replace("participants: [host, guest]", "participants: [host, ghost]"));
    const r = await bootstrap({ env: { SCENARIO_DIR: bad, RUNTIME_PORT: "0" }, logDir: tmp, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/ghost/);
  });

  it("reports a scenario that cannot be loaded", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const r = await bootstrap({ env: { SCENARIO_DIR: path.join(tmp, "missing"), RUNTIME_PORT: "0" }, logDir: tmp, log: () => {} });
    expect(r.ok).toBe(false);
  });

  it("does not run on import (importing this module started nothing)", () => {
    expect(typeof bootstrap).toBe("function");
  });
});
