import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";

// US-0060: a managed session allows at most 12 player roles. A private copy of friday-escalation (3 players) plus ten more player files.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
let scenarioDir = "";
const runtimes: Runtime[] = [];
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-cap-"));
  scenarioDir = path.join(tmp, "scenario");
  cpSync(friday, scenarioDir, { recursive: true });
  const template = readFileSync(path.join(friday, "roles/account_manager.yaml"), "utf8");
  for (let n = 1; n <= 10; n++) writeFileSync(path.join(scenarioDir, "roles", `extra_${n}.yaml`), template.replace("id: account_manager", `id: extra_${n}`));
});
afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop(); await rm(tmp, { recursive: true, force: true }); });

const boot = async (managed: boolean) => {
  const data = path.join(tmp, "sessions");
  const r = await bootstrap({
    env: { SCENARIO_DIR: scenarioDir, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "cap1", MODEL_PROVIDER: "mock", ...(managed ? { CONTROL_MANAGED: "1", SESSION_DATA_DIR: data } : { NO_DOTENV: "1" }) },
    root: tmp, ...(managed ? {} : { logDir: data }), tickMs: 60_000, log: () => {}, warn: () => {},
    ...(managed ? { parent: { send: () => true, onMessage() {}, onDisconnect() {} } } : {}),
  });
  if (r.ok) runtimes.push(r.runtime);
  return { r, data };
};
const filesOf = (d: string) => readdir(d).then((n) => n, (err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return []; throw err; });

describe("the managed player-role cap (US-0060)", () => {
  it("a managed bootstrap of a 13-player scenario fails with that message and leaves no <id>.* file in the data dir", async () => {
    const { r, data } = await boot(true);
    expect(r).toEqual({ ok: false, errors: ["a managed session allows at most 12 player roles (this scenario has 13)"] });
    expect((await filesOf(data)).filter((n) => n.startsWith("cap1."))).toEqual([]);
  });

  it("the terminal (unmanaged) bootstrap of it still starts", async () => {
    const { r } = await boot(false);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.ok).toBe(true);
  });
});
