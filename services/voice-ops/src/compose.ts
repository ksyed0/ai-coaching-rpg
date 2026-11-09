import os from "node:os";
import path from "node:path";
import type { Run } from "./run.js";
import type { VoiceOpsSettings } from "./settings.js";
import { removePrivateFile, writePrivateFileAtomic } from "./state.js";
import { isLiveKitToken, isPrivateAddress, parseIPv4 } from "./text.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 5): how `voice:up` and `voice:down` drive `deploy/compose/voice.yml` (LiveKit always, Caddy in the
 * `lan` profile). The compose file itself is fixed text (pinned images, ports, restart policy); this module builds the exact argument
 * lists and the exact environment the docker CLI gets, writes LiveKit's private key file, refuses a Docker that is not this machine's
 * or a Compose too old for the long-form `env_file`, and finds the node address LiveKit advertises.
 *
 * Secrets: the docker CLI's environment (`composeEnv`) never holds a LIVEKIT_* value, STT_URL or a DNS token; LiveKit's keys reach the
 * container only through `<VOICE_STATE_DIR>/livekit.env` (0600, in the 0700 state directory), never through an argument list (K12: a
 * recorded deviation from "secrets only in .env"; `docker inspect` shows them to anyone who can use the Docker socket). voice-ops only
 * ever runs `config --quiet`, never `config` (which would print them).
 */

export const COMPOSE_PROJECT = "scenecoach-voice";
export const COMPOSE_FILE = "deploy/compose/voice.yml";
export const MIN_COMPOSE_VERSION = "2.24.0";
export const COMPOSE_WAIT_TIMEOUT_S = 60;
/** The services of voice.yml; a service list given to `up` must name only these. */
export const COMPOSE_SERVICES = ["livekit", "caddy"] as const;
/**
 * Compose interpolates every service, active profile or not, so in `local` mode the `lan`-only names get fixed harmless values: valid
 * published ports unlikely to be in use (0 is not a valid published port) and the null device for the certificate files. Caddy is
 * never started then.
 */
export const LOCAL_DUMMY_PORTS = { https: 65533, livekitTls: 65534 } as const;
const LOCAL_DUMMY_HOSTNAME = "voice.invalid";
const LOCAL_DUMMY_UPSTREAM = "127.0.0.1:1";
const NULL_DEVICE = "/dev/null";

/**
 * The docker CLI's arguments. Every head names the file and `--env-file <null device>` (`os.devNull`, cross-platform; batch 2 review
 * B F3): Compose otherwise reads `<project dir>/.env` (deploy/compose/.env), where COMPOSE_PROFILES=lan would start Caddy in local mode
 * and any VOICE_* value would fill an interpolation `composeEnv` left out. (The process environment wins over a project `.env` anyway,
 * so a VOICE_* there could never override a value `composeEnv` sets.) `up`: detached, never a build, `--wait` (a service that exits at once fails the command instead of
 * returning 0) with a 60 s bound, quiet pulls; the `lan` profile only in `lan` mode; an optional list of services (repair mode, Task 7).
 * `down`: every profile, whatever the mode (so a `lan` stack is stopped from any setting), and orphans removed.
 */
export function composeArgs(repoRoot: string, access: "local" | "lan", verb: "up" | "down", services?: string[]): string[] {
  const head = ["compose", "-p", COMPOSE_PROJECT, "-f", path.join(path.resolve(repoRoot), COMPOSE_FILE), "--env-file", os.devNull];
  if (verb === "down") return [...head, "--profile", "lan", "down", "--remove-orphans"];
  for (const s of services ?? []) if (!(COMPOSE_SERVICES as readonly string[]).includes(s)) throw new Error("compose up names only the voice services");
  return [
    ...head, ...(access === "lan" ? ["--profile", "lan"] : []),
    "up", "-d", "--no-build", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_S), "--quiet-pull", ...(services ?? []),
  ];
}

/** PATH, HOME and every DOCKER_* name of `parent`: what the docker CLI needs to find its engine and its configuration, nothing else. */
function dockerBaseEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (parent.PATH !== undefined) env.PATH = parent.PATH;
  if (parent.HOME !== undefined) env.HOME = parent.HOME;
  for (const [k, v] of Object.entries(parent)) if (k.startsWith("DOCKER_") && v !== undefined) env[k] = v;
  return env;
}

/**
 * The docker CLI's exact environment for voice.yml: PATH, HOME, DOCKER_*, and the interpolation values. Never a LIVEKIT_*, STT_URL,
 * VOICE_DNS_API_TOKEN or COMPOSE_* name (COMPOSE_PROFILES or COMPOSE_FILE from the shell would change what starts).
 */
export function composeEnv(parent: NodeJS.ProcessEnv, s: VoiceOpsSettings, nodeIp: string): NodeJS.ProcessEnv {
  if (parseIPv4(nodeIp) === null) throw new Error("the node address must be an IPv4 address");
  const env: NodeJS.ProcessEnv = { ...dockerBaseEnv(parent), VOICE_STATE_DIR: s.stateDir, VOICE_NODE_IP: nodeIp, VOICE_MEDIA_BIND: nodeIp };
  const lan = s.access === "lan" ? s.lan : undefined;
  if (lan) {
    env.VOICE_HOSTNAME = lan.hostname;
    env.VOICE_HTTPS_PORT = String(lan.httpsPort);
    env.VOICE_LIVEKIT_TLS_PORT = String(lan.livekitTlsPort);
    env.VOICE_TLS_CERT_FILE = lan.tls.mode === "files" ? lan.tls.certFile : NULL_DEVICE;
    env.VOICE_TLS_KEY_FILE = lan.tls.mode === "files" ? lan.tls.keyFile : NULL_DEVICE;
    env.VOICE_WEB_UPSTREAM = `host.docker.internal:${s.webPort}`;
  } else {
    env.VOICE_HOSTNAME = LOCAL_DUMMY_HOSTNAME;
    env.VOICE_HTTPS_PORT = String(LOCAL_DUMMY_PORTS.https);
    env.VOICE_LIVEKIT_TLS_PORT = String(LOCAL_DUMMY_PORTS.livekitTls);
    env.VOICE_TLS_CERT_FILE = NULL_DEVICE;
    env.VOICE_TLS_KEY_FILE = NULL_DEVICE;
    env.VOICE_WEB_UPSTREAM = LOCAL_DUMMY_UPSTREAM;
  }
  return env;
}

// ---- livekit.env ----

export const LIVEKIT_ENV_FILE = "livekit.env";
const KEY_MAX = 256; // control's limits (services/control/src/voice/livekit-config.ts), as the .env writer checks them
const SECRET_MIN = 32;
const SECRET_MAX = 512;

/** A key pair LiveKit cannot be given. The message names the variable and the rule, never a value. */
export class LiveKitEnvError extends Error {
  constructor(readonly variable: "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET") {
    super(`${variable} is missing or outside LiveKit's key rule (printable, no space, quote, backslash or any of : , # $ { } [ ] & * ! | > % @ ?; key 1 to 256 characters and not a development key, secret 32 to 512): fix it in .env or remove both LIVEKIT_API_KEY and LIVEKIT_API_SECRET so voice:up generates them`);
    this.name = "LiveKitEnvError";
  }
}

/**
 * Writes `<stateDir>/livekit.env` = `LIVEKIT_KEYS=<key>: <secret>\n` from `merged` (the `loadRootEnv` view control reads, so LiveKit and
 * control hold the same pair), atomically at 0600. The pair is checked again here (batch 1 notes): the merged view could carry a
 * value `.env` never held, and a newline or a `#` would add a line or cut the value in Compose's env-file reader.
 */
export function writeLiveKitEnv(stateDir: string, merged: NodeJS.ProcessEnv): void {
  const key = merged.LIVEKIT_API_KEY;
  const secret = merged.LIVEKIT_API_SECRET;
  if (key === undefined || !isLiveKitToken(key, 1, KEY_MAX) || key.toLowerCase() === "devkey") throw new LiveKitEnvError("LIVEKIT_API_KEY");
  if (secret === undefined || !isLiveKitToken(secret, SECRET_MIN, SECRET_MAX)) throw new LiveKitEnvError("LIVEKIT_API_SECRET");
  writePrivateFileAtomic(path.join(stateDir, LIVEKIT_ENV_FILE), `LIVEKIT_KEYS=${key}: ${secret}\n`);
}

/** Removes `<stateDir>/livekit.env` (voice:down and every rollback); a missing file is fine; else StateDirError("unwritable"). */
export function removeLiveKitEnv(stateDir: string): void {
  removePrivateFile(path.join(stateDir, LIVEKIT_ENV_FILE));
}

// ---- Docker ----

const LOCAL_ONLY = "voice:up runs only against a Docker engine on this machine";
/** `[major, minor, patch]` of `2.24.0`, `v5.5.0` or `2.29.2-desktop.2`; null otherwise. */
function versionOf(raw: string): [number, number, number] | null {
  const v = raw.trim().startsWith("v") ? raw.trim().slice(1) : raw.trim();
  const parts = v.split(".");
  if (parts.length < 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    let digits = "";
    for (const c of parts[i]!) { if (c >= "0" && c <= "9") digits += c; else break; }
    if (digits === "" || (i < 2 && digits !== parts[i])) return null;
    nums.push(Number(digits));
  }
  return nums as [number, number, number];
}
function atLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) { if (v[i]! > min[i]!) return true; if (v[i]! < min[i]!) return false; }
  return true;
}
const isLocalEndpoint = (e: string): boolean => e.startsWith("unix://") || e.startsWith("npipe://");

/**
 * Why Docker cannot be used, as one fixed sentence, or null. Refused: DOCKER_HOST set to anything but `unix://...` (checked first,
 * without running anything); docker missing; `docker compose version --short` failing or older than 2.24.0; the current context's
 * endpoint (`docker context inspect --format {{.Endpoints.docker.Host}}`) not a local `unix://` or `npipe://` socket. Docker Desktop and
 * OrbStack both use a local unix socket. docker runs with PATH, HOME and DOCKER_* only.
 */
export async function dockerProblem(parent: NodeJS.ProcessEnv, run: Run): Promise<string | null> {
  const host = parent.DOCKER_HOST;
  if (host !== undefined && host !== "" && !host.startsWith("unix://")) return `${LOCAL_ONLY}: DOCKER_HOST must be unset or a unix:// socket`;
  const env = dockerBaseEnv(parent);
  let compose: Awaited<ReturnType<Run>>;
  try { compose = await run("docker", ["compose", "version", "--short"], { env, timeoutMs: 30_000 }); }
  catch { return "docker was not found on PATH: install Docker (OrbStack or Docker Desktop), then pnpm voice:up"; }
  const v = compose.code === 0 ? versionOf(compose.stdout) : null;
  if (v === null) return `Docker Compose v2 did not answer with its version: install Docker Compose ${MIN_COMPOSE_VERSION} or newer, then pnpm voice:up`;
  if (!atLeast(v, versionOf(MIN_COMPOSE_VERSION)!)) return `Docker Compose is older than ${MIN_COMPOSE_VERSION} (needed for an optional env_file): update Docker, then pnpm voice:up`;
  let ctx: Awaited<ReturnType<Run>>;
  try { ctx = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { env, timeoutMs: 30_000 }); }
  catch { return "docker was not found on PATH: install Docker (OrbStack or Docker Desktop), then pnpm voice:up"; }
  if (ctx.code !== 0) return "the current Docker context could not be read: check docker context ls, then pnpm voice:up";
  if (!isLocalEndpoint(ctx.stdout.trim())) return `${LOCAL_ONLY}: the current Docker context is not a local socket (docker context ls)`;
  return null;
}

// ---- the node address ----

/**
 * The address LiveKit advertises for media (`--node-ip`) and binds the media and TLS ports to. `local`: 127.0.0.1. `lan`: VOICE_NODE_IP
 * when it is one of this machine's private non-internal IPv4 addresses, else the single such address; none or several is an error that
 * names the interfaces, never an address.
 */
export function nodeAddress(s: VoiceOpsSettings, ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): { ok: true; ip: string } | { ok: false; error: string } {
  if (s.access === "local") return { ok: true, ip: "127.0.0.1" };
  const found = new Map<string, string[]>();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      const v4 = i.family === "IPv4" || (i.family as unknown) === 4;
      if (!v4 || i.internal || parseIPv4(i.address) === null || !isPrivateAddress(i.address)) continue;
      found.set(i.address, [...(found.get(i.address) ?? []), name]);
    }
  }
  const names = (): string => [...new Set([...found.values()].flat())].sort().join(", ");
  const wanted = s.lan?.nodeIp;
  if (wanted !== undefined) {
    if (found.has(wanted)) return { ok: true, ip: wanted };
    return { ok: false, error: `VOICE_NODE_IP is not a private IPv4 address of this machine${found.size > 0 ? ` (interfaces with one: ${names()})` : ""}: set it to the address the participants' devices reach` };
  }
  if (found.size === 1) return { ok: true, ip: [...found.keys()][0]! };
  if (found.size === 0) return { ok: false, error: "no private IPv4 address on this machine's network interfaces: connect to the LAN, or set VOICE_NODE_IP" };
  return { ok: false, error: `several private IPv4 addresses (interfaces ${names()}): set VOICE_NODE_IP to the one the participants' devices reach` };
}
