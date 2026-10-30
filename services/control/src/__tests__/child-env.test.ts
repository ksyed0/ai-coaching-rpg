import { describe, expect, it } from "vitest";
import { buildChildEnv, CHILD_ENV_ALLOWLIST, CHILD_WS_MAX_CONNECTIONS, CHILD_WS_MAX_CONNECTIONS_PER_IP } from "../child-env.js";
import type { ControlConfig } from "../config.js";

const config: ControlConfig = {
  port: 8787, serviceToken: "x".repeat(40), maxSessions: 10, dataDir: "/data/control", sessionsDir: "/data/control/sessions",
  listFile: "/data/control/sessions.json", scenariosDir: "/scen", logDir: "/data/control/child-logs", graceMs: 1, readyTimeoutMs: 1000,
};
const TOKEN = "ab".repeat(32);
const build = (parentEnv: NodeJS.ProcessEnv, token = TOKEN) =>
  buildChildEnv({ config, parentEnv, sessionId: "a".repeat(32), scenarioDir: "/scen/x", token, start: "fresh" });

const FIXED = ["CONTROL_MANAGED", "NO_DOTENV", "SESSION_ID", "SCENARIO_DIR", "SESSION_START", "SESSION_DATA_DIR", "RUNTIME_HOST", "RUNTIME_PORT",
  "TRUST_PROXY", "FACILITATOR_TOKEN", "WS_MAX_CONNECTIONS", "WS_MAX_CONNECTIONS_PER_IP"];

describe("buildChildEnv", () => {
  it("contains no variable outside the allowlist", () => {
    const parent = {
      PATH: "/bin", HOME: "/home/x", NODE_ENV: "production", MODEL_PROVIDER: "local", NPC_MODEL: "m", GM_TEMPERATURE: "0.2",
      LOCAL_BASE_URL: "http://l", ANTHROPIC_API_KEY: "k", LAUNCHER_TOKEN: "secret", FACILITATOR_SECRET: "s", JOIN_CODE: "c",
      ALLOWED_ORIGINS: "o", AWS_SECRET_ACCESS_KEY: "z", RUNTIME_PORT: "9999", FACILITATOR_TOKEN: "evil", SESSION_DATA_DIR: "/etc",
    };
    const env = build(parent);
    const a = CHILD_ENV_ALLOWLIST;
    for (const k of Object.keys(env)) {
      const ok = FIXED.includes(k) || (a.names as readonly string[]).includes(k) || a.prefixes.some((p) => k.startsWith(p));
      expect(ok, k).toBe(true);
    }
    for (const bad of ["HOME", "LAUNCHER_TOKEN", "FACILITATOR_SECRET", "JOIN_CODE", "ALLOWED_ORIGINS", "AWS_SECRET_ACCESS_KEY"]) expect(env[bad]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.NPC_MODEL).toBe("m");
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    // fixed values win over anything the parent holds
    expect(env.RUNTIME_PORT).toBe("0");
    expect(env.FACILITATOR_TOKEN).toBe(TOKEN);
    expect(env.SESSION_DATA_DIR).toBe(config.sessionsDir);
  });

  it("sets the fixed variables and the connection caps", () => {
    const env = build({});
    expect(env).toMatchObject({
      CONTROL_MANAGED: "1", NO_DOTENV: "1", SESSION_ID: "a".repeat(32), SCENARIO_DIR: "/scen/x", SESSION_START: "fresh",
      RUNTIME_HOST: "127.0.0.1", RUNTIME_PORT: "0", TRUST_PROXY: "1",
      WS_MAX_CONNECTIONS: String(CHILD_WS_MAX_CONNECTIONS), WS_MAX_CONNECTIONS_PER_IP: String(CHILD_WS_MAX_CONNECTIONS_PER_IP),
    });
    expect(buildChildEnv({ config, parentEnv: {}, sessionId: "a".repeat(32), scenarioDir: "/s", token: TOKEN, start: "resume" }).SESSION_START).toBe("resume");
  });

  it("has no GM_TRACE_FILE even if the parent does", () => {
    const env = build({ GM_TRACE_FILE: "/tmp/t", GM_TRACE_X: "1", GM_MAX_TOKENS: "10" });
    expect(env.GM_TRACE_FILE).toBeUndefined();
    expect(Object.keys(env).some((k) => k.startsWith("GM_TRACE"))).toBe(false);
    expect(env.GM_MAX_TOKENS).toBe("10");
  });

  it("token is 64 hex characters and differs per start", () => {
    const t1 = "0".repeat(64), t2 = "f".repeat(64);
    expect(build({}, t1).FACILITATOR_TOKEN).toBe(t1);
    expect(build({}, t2).FACILITATOR_TOKEN).not.toBe(build({}, t1).FACILITATOR_TOKEN);
    for (const bad of ["", "ab", "AB".repeat(32), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(() => build({}, bad)).toThrow();
  });

  it("SESSION_DATA_DIR is absolute and under CONTROL_DATA_DIR", () => {
    const env = build({});
    expect(env.SESSION_DATA_DIR!.startsWith("/")).toBe(true);
    expect(env.SESSION_DATA_DIR!.startsWith(`${config.dataDir}/`)).toBe(true);
    expect(() => buildChildEnv({ config: { ...config, sessionsDir: "rel" }, parentEnv: {}, sessionId: "a".repeat(32), scenarioDir: "/s", token: TOKEN, start: "fresh" })).toThrow();
  });
});
