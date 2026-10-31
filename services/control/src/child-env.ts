import path from "node:path";
import type { ControlConfig } from "./config.js";

/**
 * What a runtime child may inherit from the control service's own environment. Nothing else is copied (no HOME, no secrets of the
 * service such as LAUNCHER_TOKEN, no JOIN_CODE*, no ALLOWED_ORIGINS). `GM_TRACE*` is excluded even though `GM_` is allowed.
 */
export const CHILD_ENV_ALLOWLIST = {
  names: [
    "PATH", "MODEL_PROVIDER", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "LOCAL_BASE_URL",
    "LOCAL_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY",
    "PLAYER_TEMPERATURE", "MODEL_MAX_RETRIES", "MODEL_RETRY_BASE_MS", "SESSION_LOCK_STALE_MS", "CONSENT_NOTICE_VERSION",
  ],
  prefixes: ["NODE_", "NPC_", "GM_", "EVAL_"],
  excludedPrefixes: ["GM_TRACE"],
} as const;

/** Spec 7.1: the control service sets the connection caps explicitly for every child. */
export const CHILD_WS_MAX_CONNECTIONS = 32;
export const CHILD_WS_MAX_CONNECTIONS_PER_IP = 8;

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isAllowedChildVar(name: string): boolean {
  const a = CHILD_ENV_ALLOWLIST;
  if (a.excludedPrefixes.some((p) => name.startsWith(p))) return false;
  return (a.names as readonly string[]).includes(name) || a.prefixes.some((p) => name.startsWith(p));
}

export function buildChildEnv(o: {
  config: ControlConfig; parentEnv: NodeJS.ProcessEnv; sessionId: string; scenarioDir: string; token: string; start: "resume" | "fresh";
}): NodeJS.ProcessEnv {
  if (!TOKEN_RE.test(o.token)) throw new Error("the facilitator token must be 64 hex characters");
  if (!path.isAbsolute(o.config.sessionsDir)) throw new Error("the sessions directory must be absolute");
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.parentEnv)) if (v !== undefined && isAllowedChildVar(k)) env[k] = v;
  return {
    ...env,
    CONTROL_MANAGED: "1",
    NO_DOTENV: "1",
    SESSION_ID: o.sessionId,
    SCENARIO_DIR: o.scenarioDir,
    SESSION_START: o.start,
    SESSION_DATA_DIR: o.config.sessionsDir,
    RUNTIME_HOST: "127.0.0.1",
    RUNTIME_PORT: "0",
    TRUST_PROXY: "1",
    FACILITATOR_TOKEN: o.token,
    WS_MAX_CONNECTIONS: String(CHILD_WS_MAX_CONNECTIONS),
    WS_MAX_CONNECTIONS_PER_IP: String(CHILD_WS_MAX_CONNECTIONS_PER_IP),
  };
}
