import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadControlConfig, loadControlEnv } from "../config.js";

const TOKEN = "t".repeat(40);
const DATA = path.resolve(tmpdir(), "acr-control-data");
const base = (): NodeJS.ProcessEnv => ({ LAUNCHER_TOKEN: TOKEN, CONTROL_DATA_DIR: DATA });
const problems = (env: NodeJS.ProcessEnv): string => {
  try { loadControlConfig(env); } catch (e) { return (e as Error).message; }
  throw new Error("expected loadControlConfig to throw");
};

describe("loadControlConfig", () => {
  it("applies defaults and derives paths", () => {
    const c = loadControlConfig(base());
    expect(c.port).toBe(8787);
    expect(c.serviceToken).toBe(TOKEN);
    expect(c.maxSessions).toBe(10);
    expect(c.dataDir).toBe(DATA);
    expect(c.sessionsDir).toBe(path.join(DATA, "sessions"));
    expect(c.listFile).toBe(path.join(DATA, "sessions.json"));
    expect(c.logDir).toBe(path.join(DATA, "child-logs"));
    expect(path.isAbsolute(c.scenariosDir)).toBe(true);
    expect(c.scenariosDir.endsWith(`${path.sep}scenarios`)).toBe(true);
    expect(c.graceMs).toBe(30_000);
    expect(c.readyTimeoutMs).toBe(30_000);
  });

  it("reads every override", () => {
    const logDir = path.resolve(tmpdir(), "acr-logs");
    const scen = path.resolve(tmpdir(), "acr-scen");
    const c = loadControlConfig({ ...base(), CONTROL_PORT: "9001", MAX_SESSIONS: "3", CONTROL_LOG_DIR: logDir, SCENARIOS_DIR: scen, CONTROL_GRACE_MS: "0", CONTROL_READY_TIMEOUT_MS: "1000" });
    expect([c.port, c.maxSessions, c.logDir, c.scenariosDir, c.graceMs, c.readyTimeoutMs]).toEqual([9001, 3, logDir, scen, 0, 1000]);
  });

  it("a short token is refused, naming the variable and never the value", () => {
    const secret = "short-secret-value";
    const m = problems({ ...base(), LAUNCHER_TOKEN: secret });
    expect(m).toContain("LAUNCHER_TOKEN");
    expect(m).not.toContain(secret);
  });

  it("a missing token or data dir is refused", () => {
    const m = problems({});
    expect(m).toContain("LAUNCHER_TOKEN");
    expect(m).toContain("CONTROL_DATA_DIR");
  });

  it("a bad port is refused without echoing the value", () => {
    for (const bad of ["0", "65536", "80.5", "abc", "-1", "1e3", " 80", ""]) {
      const m = problems({ ...base(), CONTROL_PORT: bad });
      expect(m).toContain("CONTROL_PORT");
      if (bad.length > 1) expect(m).not.toContain(JSON.stringify(bad));
    }
  });

  it("MAX_SESSIONS outside 1 to 100 or not whole is refused", () => {
    for (const bad of ["0", "101", "2.5", "x", "-3"]) expect(problems({ ...base(), MAX_SESSIONS: bad })).toContain("MAX_SESSIONS");
  });

  it("a relative CONTROL_DATA_DIR is refused and its value is not echoed", () => {
    const m = problems({ ...base(), CONTROL_DATA_DIR: "relative/secret-dir" });
    expect(m).toContain("CONTROL_DATA_DIR");
    expect(m).not.toContain("secret-dir");
  });

  it("grace and ready timeouts are range checked", () => {
    expect(problems({ ...base(), CONTROL_GRACE_MS: "3600001" })).toContain("CONTROL_GRACE_MS");
    expect(problems({ ...base(), CONTROL_GRACE_MS: "-1" })).toContain("CONTROL_GRACE_MS");
    expect(problems({ ...base(), CONTROL_READY_TIMEOUT_MS: "999" })).toContain("CONTROL_READY_TIMEOUT_MS");
    expect(problems({ ...base(), CONTROL_READY_TIMEOUT_MS: "600001" })).toContain("CONTROL_READY_TIMEOUT_MS");
  });

  it("relative SCENARIOS_DIR and CONTROL_LOG_DIR are refused", () => {
    expect(problems({ ...base(), SCENARIOS_DIR: "rel" })).toContain("SCENARIOS_DIR");
    expect(problems({ ...base(), CONTROL_LOG_DIR: "rel" })).toContain("CONTROL_LOG_DIR");
  });

  it("collects every problem into one error", () => {
    const m = problems({ LAUNCHER_TOKEN: "x", CONTROL_PORT: "0", MAX_SESSIONS: "0", CONTROL_DATA_DIR: "rel" });
    for (const v of ["LAUNCHER_TOKEN", "CONTROL_PORT", "MAX_SESSIONS", "CONTROL_DATA_DIR"]) expect(m).toContain(v);
  });
});

describe("loadControlEnv", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const root = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-env-")); dirs.push(d); return d; };

  it("merges <root>/.env with real environment variables winning", () => {
    const r = root();
    writeFileSync(path.join(r, ".env"), "ANTHROPIC_API_KEY=from-file\nCONTROL_PORT=1111\n");
    const env = loadControlEnv(r, { CONTROL_PORT: "2222" });
    expect(env.CONTROL_PORT).toBe("2222");
    expect(env.ANTHROPIC_API_KEY).toBe("from-file");
  });

  it("returns the real environment when there is no .env", () => {
    expect(loadControlEnv(root(), { A: "1" })).toEqual({ A: "1" });
  });

  it("an unreadable .env fails with a plain message that has no path or content", () => {
    const r = root();
    mkdirSync(path.join(r, ".env")); // a directory: reading it fails
    let m = "";
    try { loadControlEnv(r, {}); } catch (e) { m = (e as Error).message; }
    expect(m).toContain(".env");
    expect(m).not.toContain(r);
  });
});
