import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { parseAudioSettings } from "./voice/audio-settings.js";

/** services/control/src/config.ts: the repo root is three levels up from this file's directory. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type ControlConfig = {
  /** TCP port; the service binds loopback only (this module only parses). */
  port: number;
  /** Shared secret the BFF presents. Never log it. */
  serviceToken: string;
  /** Live sessions allowed at once. */
  maxSessions: number;
  dataDir: string;
  /** US-0073: AUDIO_DIR (absolute; default `<dataDir>/audio`), AUDIO_MIN_FREE_MB (512 to 1000000, default 2048), AUDIO_MAX_RETENTION_DAYS (1 to 30, default 30). */
  audioDir: string;
  audioMinFreeMb: number;
  audioMaxRetentionDays: number;
  /** `<dataDir>/sessions`: the children's SESSION_DATA_DIR. */
  sessionsDir: string;
  /** `<dataDir>/sessions.json`. */
  listFile: string;
  scenariosDir: string;
  logDir: string;
  graceMs: number;
  readyTimeoutMs: number;
  /** US-0060: `<dataDir>/intents`, the AI players' intent files. */
  intentsDir: string;
  /** US-0060: the live AI players' settings (PLAYER_MODEL, AI_PLAYER_*, NPC_* timeouts); parsed once, refused with the rest. */
  aiPlayer: AiPlayerSettings;
  /** EPIC-0002: `<dataDir>/reports`, where the moderate CLI writes review folders (the moderate CLI creates them; this service also appends the participants' review events there). */
  reportsDir: string;
  /** EPIC-0002: `<dataDir>/report-access.json`, the hashed report-link credentials (outside every review folder). */
  reportAccessFile: string;
  /** EPIC-0002: how long a report link lives, in days (1 to 365). */
  reportAccessDays: number;
  /** EPIC-0002: added to `bound × EVAL_TIMEOUT_MS` for the overall timeout of one evaluate run, in ms (0 to 3600000). */
  evaluateMarginMs: number;
  /** US-0083: `<dataDir>/accounts.json`, the facilitator and admin accounts (hashes only). */
  accountsFile: string;
  /** US-0083: `<dataDir>/session-owners.json`, which account owns which session (kept apart from sessions.json). */
  ownersFile: string;
  /** US-0083: ADMIN_BOOTSTRAP_PASSWORD (10 to 200 characters), the default admin's first password. A secret: never log it. */
  adminBootstrapPassword: string;
  /** US-0083: ADMIN_RESET === "1" resets the default admin's password at start. */
  adminReset: boolean;
};

const TOKEN_MIN_CHARS = 32;

/**
 * Merges `<root>/.env` (optional) under the real environment, which wins, like the runtime's bootstrap. The error never names the
 * path or any content: the file may hold provider keys.
 */
export function loadControlEnv(root: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = path.join(root, ".env");
  // Read and look at the error, never "does it exist" first: nothing can change between the check and the read.
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...env };
    throw new Error(`cannot read .env (${(err as NodeJS.ErrnoException).code ?? "unreadable"})`);
  }
  let fileEnv: NodeJS.ProcessEnv;
  try { fileEnv = parseEnv(text); }
  catch { throw new Error("cannot read .env (unreadable)"); }
  return { ...fileEnv, ...env };
}

/**
 * Parses the control service's settings. Every problem is collected and thrown as ONE Error naming each variable and its rule, never a
 * value (LAUNCHER_TOKEN is a secret and the other values may carry paths).
 */
export function loadControlConfig(env: NodeJS.ProcessEnv): ControlConfig {
  const problems: string[] = [];
  const whole = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return def;
    if (!/^[0-9]{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return def;
    }
    return Number(raw);
  };
  const absDir = (name: string, def: string | undefined): string => {
    const raw = env[name];
    if (raw === undefined) {
      if (def === undefined) problems.push(`${name} is required (an absolute directory path)`);
      return def ?? "";
    }
    if (raw === "" || raw.includes("\0") || !path.isAbsolute(raw)) {
      problems.push(`${name} must be an absolute directory path`);
      return def ?? "";
    }
    return path.resolve(raw);
  };

  const port = whole("CONTROL_PORT", 8787, 1, 65535);
  const token = env.LAUNCHER_TOKEN;
  if (token === undefined || token === "") problems.push(`LAUNCHER_TOKEN is required (at least ${TOKEN_MIN_CHARS} characters)`);
  else if (token.length < TOKEN_MIN_CHARS) problems.push(`LAUNCHER_TOKEN must be at least ${TOKEN_MIN_CHARS} characters`);
  const maxSessions = whole("MAX_SESSIONS", 10, 1, 100);
  const dataDir = absDir("CONTROL_DATA_DIR", undefined);
  const scenariosDir = absDir("SCENARIOS_DIR", path.join(REPO_ROOT, "scenarios"));
  const logDir = absDir("CONTROL_LOG_DIR", dataDir === "" ? undefined : path.join(dataDir, "child-logs"));
  const graceMs = whole("CONTROL_GRACE_MS", 30_000, 0, 3_600_000);
  const readyTimeoutMs = whole("CONTROL_READY_TIMEOUT_MS", 30_000, 1000, 600_000);

  const reportAccessDays = whole("REPORT_ACCESS_DAYS", 90, 1, 365);
  const evaluateMarginMs = whole("REPORT_EVALUATE_MARGIN_MS", 120_000, 0, 3_600_000);

  const bootstrap = env.ADMIN_BOOTSTRAP_PASSWORD ?? "ChangeMe-Admin-1";
  if (bootstrap.length < 10 || bootstrap.length > 200) problems.push("ADMIN_BOOTSTRAP_PASSWORD must be 10 to 200 characters");

  // US-0073: with no usable dataDir (already reported) the audio default is not computed.
  const audio = parseAudioSettings(env, dataDir === "" ? path.sep : dataDir);
  if (!audio.ok) problems.push(...audio.errors);

  const ai = parseAiPlayerSettings(env);
  if (!ai.ok) problems.push(...ai.errors);

  if (problems.length > 0 || !ai.ok || !audio.ok) throw new Error(`invalid control service settings: ${problems.join("; ")}`);
  return {
    port, serviceToken: token as string, maxSessions, dataDir,
    audioDir: audio.audioDir, audioMinFreeMb: audio.minFreeMb, audioMaxRetentionDays: audio.maxRetentionDays,
    sessionsDir: path.join(dataDir, "sessions"), listFile: path.join(dataDir, "sessions.json"),
    scenariosDir, logDir, graceMs, readyTimeoutMs, intentsDir: path.join(dataDir, "intents"), aiPlayer: ai.settings,
    reportsDir: path.join(dataDir, "reports"), reportAccessFile: path.join(dataDir, "report-access.json"), reportAccessDays,
    evaluateMarginMs, accountsFile: path.join(dataDir, "accounts.json"), ownersFile: path.join(dataDir, "session-owners.json"), adminBootstrapPassword: bootstrap, adminReset: env.ADMIN_RESET === "1",
  };
}
