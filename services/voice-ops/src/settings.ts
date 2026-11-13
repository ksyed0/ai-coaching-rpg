import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { isHostname, isLowerName, isPrivateAddress, isSafeIdText, parseIPv4 } from "./text.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 1): the settings of `voice:up`, `voice:check` and `voice:down`. Read from the same merged view the
 * control service uses (`loadRootEnv`: `<root>/.env` under the real environment). Every error names the variable and its rule, never a
 * value: paths, hostnames and the LiveKit host may all be sensitive, and the file holds secrets.
 *
 * Two rules are duplicated here because voice-ops may import only `node:` built-ins and `@acr/adapters`: LIVEKIT_HOST (control's
 * `parseHost`, services/control/src/voice/livekit-config.ts) and STT_MODEL (the worker's, services/speech/src/config.ts). A shared
 * fixture (`src/__tests__/fixtures/shared-rules.json`) is read by the voice-ops, control and speech tests, so the copies cannot drift.
 */

export type TlsSetting = { mode: "files"; certFile: string; keyFile: string } | { mode: "dns"; provider: string };
export type VoiceOpsSettings = {
  /** VOICE_ACCESS: `local` (this machine only, the default) or `lan` (a hostname, a certificate and the TLS proxy). */
  access: "local" | "lan";
  /** VOICE_STATE_DIR: absolute, outside the repository; default `<home>/.scenecoach/voice`. */
  stateDir: string;
  /** STT_MODEL (the worker's label rule, default `small.en`) and STT_MODEL_FILE (absolute, default `<home>/.scenecoach/models/ggml-<label>.bin`, K9). */
  model: { label: string; file: string };
  /** VOICE_WEB_PORT: 1024..65535, default 3000. */
  webPort: number;
  /** LIVEKIT_HOST: control's rule, default http://127.0.0.1:7880. */
  livekitHost: URL;
  /** Only with VOICE_ACCESS=lan. */
  lan?: { hostname: string; nodeIp?: string; httpsPort: number; livekitTlsPort: number; tls: TlsSetting };
  /** AUDIO_MIN_FREE_MB: 512..1 000 000, default 2048 (A2's rule, K11). */
  audioMinFreeMb: number;
  /** AUDIO_DIR (absolute), else `<CONTROL_DATA_DIR>/audio` when CONTROL_DATA_DIR is an absolute path. */
  audioDir?: string;
};

export const DEFAULT_LIVEKIT_HOST = "http://127.0.0.1:7880";
export const DEFAULT_STT_MODEL = "small.en";
const MAX_STT_MODEL_CHARS = 64;
const LIVEKIT_HOST_RULE = "LIVEKIT_HOST must be http://127.0.0.1:<port> or http://[::1]:<port> with no path, user, query or fragment";
const STT_MODEL_RULE = `STT_MODEL must be 1 to ${MAX_STT_MODEL_CHARS} characters, dot-separated parts of letters, digits, _ or -`;
const HOSTNAME_RULE = "a DNS name of at least two labels, not localhost or an address";

/** Control's LIVEKIT_HOST rule (services/control/src/voice/livekit-config.ts `parseHost`), repeated; pinned by the shared fixture. */
export function parseLiveKitHost(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "http:" || !loopback || u.port === "" || u.username !== "" || u.password !== "") return null;
  if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "" || raw.includes("?") || raw.includes("#")) return null;
  return u;
}

/** The worker's STT_MODEL rule (services/speech/src/config.ts `isModelName`), repeated; pinned by the shared fixture. */
export function isModelLabel(v: string): boolean {
  return v.length >= 1 && v.length <= MAX_STT_MODEL_CHARS && v.split(".").every((part) => isSafeIdText(part));
}

/** A decimal whole number of 1 to 10 digits, no sign, no space; otherwise null. */
function wholeNumber(raw: string): number | null {
  if (raw.length < 1 || raw.length > 10) return null;
  for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (c < 0x30 || c > 0x39) return null; }
  return Number(raw);
}

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function parseVoiceOpsSettings(env: NodeJS.ProcessEnv, o: { home: string; repoRoot: string }): { ok: true; s: VoiceOpsSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  /** Unset and empty are the same: the default applies. */
  const get = (name: string): string | undefined => { const v = env[name]; return v === undefined || v === "" ? undefined : v; };
  const whole = (name: string, dflt: number, lo: number, hi: number): number => {
    const raw = get(name);
    if (raw === undefined) return dflt;
    const n = wholeNumber(raw);
    if (n === null || n < lo || n > hi) { errors.push(`${name} must be a whole number from ${lo} to ${hi}`); return dflt; }
    return n;
  };
  const absolute = (name: string, raw: string): string | null => {
    if (!path.isAbsolute(raw)) { errors.push(`${name} must be an absolute path`); return null; }
    return path.resolve(raw);
  };

  const accessRaw = get("VOICE_ACCESS") ?? "local";
  let access: "local" | "lan" = "local";
  if (accessRaw === "local" || accessRaw === "lan") access = accessRaw;
  else errors.push("VOICE_ACCESS must be local or lan");

  const stateDir = absolute("VOICE_STATE_DIR", get("VOICE_STATE_DIR") ?? path.join(o.home, ".scenecoach", "voice"));
  if (stateDir !== null && isInside(o.repoRoot, stateDir)) errors.push("VOICE_STATE_DIR must be outside the repository");

  const labelRaw = get("STT_MODEL") ?? DEFAULT_STT_MODEL;
  const labelOk = isModelLabel(labelRaw);
  if (!labelOk) errors.push(STT_MODEL_RULE);
  const label = labelOk ? labelRaw : DEFAULT_STT_MODEL;
  const modelFile = absolute("STT_MODEL_FILE", get("STT_MODEL_FILE") ?? path.join(o.home, ".scenecoach", "models", `ggml-${label}.bin`));

  const webPort = whole("VOICE_WEB_PORT", 3000, 1024, 65535);

  const livekitHost = parseLiveKitHost(get("LIVEKIT_HOST") ?? DEFAULT_LIVEKIT_HOST);
  if (!livekitHost) errors.push(LIVEKIT_HOST_RULE);

  let lan: VoiceOpsSettings["lan"];
  if (access === "lan") {
    const hostRaw = get("VOICE_HOSTNAME");
    if (hostRaw === undefined) errors.push(`VOICE_HOSTNAME is required with VOICE_ACCESS=lan (${HOSTNAME_RULE})`);
    else if (!isHostname(hostRaw)) errors.push(`VOICE_HOSTNAME must be ${HOSTNAME_RULE}`);
    const nodeIpRaw = get("VOICE_NODE_IP");
    if (nodeIpRaw !== undefined && !(parseIPv4(nodeIpRaw) && isPrivateAddress(nodeIpRaw))) {
      errors.push("VOICE_NODE_IP must be a private IPv4 address of this machine (10/8, 172.16/12 or 192.168/16)");
    }
    const httpsPort = whole("VOICE_HTTPS_PORT", 443, 1, 65535);
    const livekitTlsPort = whole("VOICE_LIVEKIT_TLS_PORT", 7443, 1, 65535);
    if (httpsPort === livekitTlsPort) errors.push("VOICE_HTTPS_PORT and VOICE_LIVEKIT_TLS_PORT must differ");
    let tls: TlsSetting | undefined;
    const mode = get("VOICE_TLS_MODE") ?? "files";
    if (mode === "files") {
      const file = (name: string): string | null => {
        const raw = get(name);
        if (raw === undefined || !path.isAbsolute(raw)) { errors.push(`${name} is required with VOICE_TLS_MODE=files (an absolute path)`); return null; }
        return path.resolve(raw);
      };
      const certFile = file("VOICE_TLS_CERT_FILE");
      const keyFile = file("VOICE_TLS_KEY_FILE");
      if (certFile !== null && keyFile !== null) tls = { mode: "files", certFile, keyFile };
    } else if (mode === "dns") {
      const provider = get("VOICE_DNS_PROVIDER");
      if (provider === undefined || !isLowerName(provider, 64)) errors.push("VOICE_DNS_PROVIDER is required with VOICE_TLS_MODE=dns (1 to 64 lower-case letters, digits or -)");
      else tls = { mode: "dns", provider };
    } else errors.push("VOICE_TLS_MODE must be files or dns");
    if (hostRaw !== undefined && isHostname(hostRaw) && tls) {
      lan = { hostname: hostRaw, ...(nodeIpRaw !== undefined ? { nodeIp: nodeIpRaw } : {}), httpsPort, livekitTlsPort, tls };
    }
  }

  const audioMinFreeMb = whole("AUDIO_MIN_FREE_MB", 2048, 512, 1_000_000);
  let audioDir: string | undefined;
  const audioRaw = get("AUDIO_DIR");
  if (audioRaw !== undefined) audioDir = absolute("AUDIO_DIR", audioRaw) ?? undefined;
  else {
    const dataDir = get("CONTROL_DATA_DIR");
    if (dataDir !== undefined && path.isAbsolute(dataDir)) audioDir = path.join(path.resolve(dataDir), "audio");
  }

  if (errors.length > 0 || stateDir === null || modelFile === null || !livekitHost) return { ok: false, errors };
  return {
    ok: true,
    s: { access, stateDir, model: { label, file: modelFile }, webPort, livekitHost, ...(lan ? { lan } : {}), audioMinFreeMb, ...(audioDir !== undefined ? { audioDir } : {}) },
  };
}

/**
 * Control's rule (services/control/src/config.ts `loadControlEnv`), repeated so voice-ops reads exactly what control will read:
 * `<root>/.env` (optional) merged UNDER the real environment, which wins. The error never names the path or any content. A copy: the
 * given environment is not changed.
 */
export function loadRootEnv(repoRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = path.join(repoRoot, ".env");
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
