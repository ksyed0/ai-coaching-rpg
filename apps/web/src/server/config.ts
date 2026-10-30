// Environment parsing for the BFF. Every message names the variable and the rule but never a value: keys and URLs may be secrets.

export type Config = {
  runtimeUrl: string;
  publicOrigin: string;
  cookieKeys: { id: string; key: Buffer }[];
  cookieMaxAgeHours: number;
  maxStreams: number;
  maxStreamsPerSession: number;
  maxStreamsPerAddress: number;
  /** The facilitator console: usable only when all three are set (see consoleEnabled). */
  facilitatorSecret?: string;
  launcherUrl?: string;
  launcherToken?: string;
};

/** The console variables that are unset (names only). Empty means the console is enabled. */
export function missingConsoleVars(c: Pick<Config, "facilitatorSecret" | "launcherUrl" | "launcherToken">): string[] {
  return [["FACILITATOR_SECRET", c.facilitatorSecret], ["LAUNCHER_URL", c.launcherUrl], ["LAUNCHER_TOKEN", c.launcherToken]].filter(([, v]) => !v).map(([n]) => n as string);
}

const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_KEYS = 8;

function int(env: Record<string, string | undefined>, name: string, def: number, min: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return def;
  }
  return Number(raw);
}

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

function parseKeys(raw: string | undefined, problems: string[]): Config["cookieKeys"] {
  const rule = `COOKIE_KEYS must be 1 to ${MAX_KEYS} comma-separated id:base64key entries, newest first; each id 1 to 16 characters of A-Z a-z 0-9 _ - and unique, each key standard padded base64 for exactly 32 bytes (spaces around entries are ignored)`;
  if (!raw) { problems.push(rule); return []; }
  const out: Config["cookieKeys"] = [];
  const parts = raw.split(",").map((p) => p.trim());
  let valid = parts.length >= 1 && parts.length <= MAX_KEYS;
  for (const part of parts) {
    const at = part.indexOf(":");
    const id = at < 0 ? "" : part.slice(0, at).trim();
    const b64 = at < 0 ? "" : part.slice(at + 1).trim();
    const key = Buffer.from(b64, "base64");
    // Re-encoding must match: Buffer.from silently skips invalid base64 characters.
    if (!KEY_ID.test(id) || key.length !== 32 || key.toString("base64") !== b64 || out.some((k) => k.id === id)) { valid = false; continue; }
    out.push({ id, key });
  }
  if (!valid) { problems.push(rule); return []; }
  return out;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  const launcherRaw = env.LAUNCHER_URL === "" ? undefined : env.LAUNCHER_URL;
  const launcher = parseUrl(launcherRaw);
  let launcherUrl: string | undefined;
  if (launcherRaw !== undefined) {
    if (!launcher || launcher.protocol !== "http:" || (launcher.hostname !== "127.0.0.1" && launcher.hostname !== "localhost") || launcher.port === "" || launcher.username !== "" || launcher.password !== "" || launcher.pathname !== "/" || launcher.search !== "" || launcher.hash !== "") {
      problems.push("LAUNCHER_URL must be an http://127.0.0.1:<port> or http://localhost:<port> URL with no credentials or path");
    } else launcherUrl = launcher.origin;
  }
  const facilitatorSecret = env.FACILITATOR_SECRET === "" ? undefined : env.FACILITATOR_SECRET;
  if (facilitatorSecret !== undefined && facilitatorSecret.length < 16) problems.push("FACILITATOR_SECRET must be at least 16 characters");
  const launcherToken = env.LAUNCHER_TOKEN === "" ? undefined : env.LAUNCHER_TOKEN;
  if (launcherToken !== undefined && launcherToken.length < 32) problems.push("LAUNCHER_TOKEN must be at least 32 characters");
  // With LAUNCHER_URL the PLAYER routes look each session's runtime up through the control service, which needs the token: without it
  // no join or stream could work, so this is a configuration error, not a disabled console. (FACILITATOR_SECRET stays optional.)
  if (launcherRaw !== undefined && launcherToken === undefined) problems.push("LAUNCHER_TOKEN is required when LAUNCHER_URL is set (the player routes look up each session's runtime through the control service)");

  // RUNTIME_URL stays required only for a player-only deployment (no LAUNCHER_URL).
  const runtime = parseUrl(env.RUNTIME_URL);
  if (launcherRaw === undefined && (!runtime || (runtime.protocol !== "ws:" && runtime.protocol !== "wss:") || runtime.username !== "" || runtime.password !== "")) {
    problems.push("RUNTIME_URL is required and must be a ws:// or wss:// URL without credentials (unless LAUNCHER_URL is set)");
  } else if (launcherRaw !== undefined && env.RUNTIME_URL !== undefined && env.RUNTIME_URL !== "" && (!runtime || (runtime.protocol !== "ws:" && runtime.protocol !== "wss:") || runtime.username !== "" || runtime.password !== "")) {
    problems.push("RUNTIME_URL must be a ws:// or wss:// URL without credentials");
  }

  const origin = parseUrl(env.PUBLIC_ORIGIN);
  if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== env.PUBLIC_ORIGIN) {
    problems.push("PUBLIC_ORIGIN is required and must be an origin: scheme://host[:port] with no path");
  }

  const cookieKeys = parseKeys(env.COOKIE_KEYS, problems);
  const cookieMaxAgeHours = int(env, "COOKIE_MAX_AGE_HOURS", 12, 1, 168, problems);
  const maxStreams = int(env, "WEB_MAX_STREAMS", 200, 1, 10_000, problems);
  const maxStreamsPerSession = int(env, "WEB_MAX_STREAMS_PER_SESSION", 64, 1, 1000, problems);
  const maxStreamsPerAddress = int(env, "WEB_MAX_STREAMS_PER_ADDRESS", 16, 1, 1000, problems);

  if (problems.length > 0) throw new Error(`Invalid web configuration: ${problems.join("; ")}`);
  return {
    runtimeUrl: env.RUNTIME_URL ?? "", publicOrigin: env.PUBLIC_ORIGIN!, cookieKeys, cookieMaxAgeHours, maxStreams, maxStreamsPerSession, maxStreamsPerAddress,
    ...(facilitatorSecret !== undefined && { facilitatorSecret }), ...(launcherUrl !== undefined && { launcherUrl }), ...(launcherToken !== undefined && { launcherToken }),
  };
}
