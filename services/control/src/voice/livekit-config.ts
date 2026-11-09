/**
 * US-0071 (EPIC-0003 voice A1b, Task 5, K2): control's LiveKit settings. Only the control service reads them: the key and the secret
 * never reach a child (CHILD_ENV_ALLOWLIST and SPEECH_ENV_ALLOWLIST leave every LIVEKIT_* out). The public `wss` URL the browser uses is
 * the web app's own LIVEKIT_URL (its CSP needs it); control needs only the server API address, LIVEKIT_HOST, loopback `http:` (the
 * pilot laptop), from which the worker's signalling URL `ws://<host>:<port>` is derived and sent in `livekit_join`.
 * Every error names variables only, never a value (the secret, the key and the host may all be sensitive).
 */
export type LiveKitConfig = { apiKey: string; apiSecret: string; host: URL; workerUrl: string };

export const DEFAULT_LIVEKIT_HOST = "http://127.0.0.1:7880";
export const LIVEKIT_SECRET_MIN_CHARS = 32;
const KEY_MAX_CHARS = 256;
const SECRET_MAX_CHARS = 512;

/** Printable ASCII with no space (a LiveKit key and secret are generated tokens). Checked character by character. */
function isTokenText(v: string, max: number): boolean {
  if (v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (c <= 0x20 || c >= 0x7f) return false; }
  return true;
}

function parseHost(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "http:" || !loopback || u.port === "" || u.username !== "" || u.password !== "") return null;
  if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "" || raw.includes("?") || raw.includes("#")) return null;
  return u;
}

export function parseLiveKitConfig(env: NodeJS.ProcessEnv): { ok: true; cfg: LiveKitConfig | null } | { ok: false; errors: string[] } {
  const key = env.LIVEKIT_API_KEY ?? "";
  const secret = env.LIVEKIT_API_SECRET ?? "";
  const hostRaw = env.LIVEKIT_HOST ?? "";
  if (key === "" && secret === "") {
    if (hostRaw !== "") return { ok: false, errors: ["LIVEKIT_HOST is set but LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not"] };
    return { ok: true, cfg: null };
  }
  const errors: string[] = [];
  if (key === "" || secret === "") errors.push("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together");
  else {
    if (!isTokenText(key, KEY_MAX_CHARS)) errors.push(`LIVEKIT_API_KEY must be 1 to ${KEY_MAX_CHARS} printable characters with no space`);
    if (secret.length < LIVEKIT_SECRET_MIN_CHARS || !isTokenText(secret, SECRET_MAX_CHARS)) {
      errors.push(`LIVEKIT_API_SECRET must be ${LIVEKIT_SECRET_MIN_CHARS} to ${SECRET_MAX_CHARS} printable characters with no space`);
    }
  }
  const host = parseHost(hostRaw === "" ? DEFAULT_LIVEKIT_HOST : hostRaw);
  if (!host) errors.push("LIVEKIT_HOST must be http://127.0.0.1:<port> or http://[::1]:<port> with no path, user, query or fragment");
  if (errors.length > 0 || !host) return { ok: false, errors };
  return { ok: true, cfg: { apiKey: key, apiSecret: secret, host, workerUrl: `ws://${host.host}` } };
}

/**
 * What stops the control service from starting (main.ts): a bad LiveKit setting, or SPEECH_INGEST=livekit without LiveKit (a LiveKit
 * worker could never get a token). Fixed sentences naming variables only.
 */
export function liveKitStartProblems(env: NodeJS.ProcessEnv): string[] {
  const r = parseLiveKitConfig(env);
  if (!r.ok) return r.errors;
  if (env.SPEECH_INGEST === "livekit" && r.cfg === null) return ["SPEECH_INGEST=livekit needs LIVEKIT_API_KEY and LIVEKIT_API_SECRET"];
  return [];
}

/**
 * US-0071 (A1b batch 3 review F8): seat rooms, generations and tokens exist only when control has LiveKit settings AND its speech
 * workers read LiveKit (SPEECH_INGEST=livekit). With file ingest nobody listens to a seat room, so no browser may be given a token to
 * publish into one: token requests are then `voice_unavailable`.
 */
export function voiceTokensWanted(env: NodeJS.ProcessEnv, cfg: LiveKitConfig | null): cfg is LiveKitConfig {
  return cfg !== null && env.SPEECH_INGEST === "livekit";
}
