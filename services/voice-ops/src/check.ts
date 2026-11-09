import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { parseSttUrl } from "@acr/adapters";
import { backupCheck } from "./checks/backup.js";
import { caddyManagedCert, certificateCheck } from "./checks/certificate.js";
import { diskCheck } from "./checks/disk.js";
import { dnsCheck } from "./checks/dns.js";
import { livekitCheck } from "./checks/livekit.js";
import { livekitKeysCheck, type KeysRequest } from "./checks/livekit-keys.js";
import { portsCheck } from "./checks/ports.js";
import { tlsRouteCheck } from "./checks/tls.js";
import type { CheckResult } from "./checks/types.js";
import { versionsCheck } from "./checks/versions.js";
import { lanAddressesOf, webCheck } from "./checks/web.js";
import { whisperCheck } from "./checks/whisper.js";
import { COMPOSE_FILE, dockerProblem, nodeAddress } from "./compose.js";
import type { OpsDeps } from "./ops.js";
import { MANAGED_NAMES } from "./env-file.js";
import { DEFAULT_LIVEKIT_HOST, loadRootEnv, parseVoiceOpsSettings } from "./settings.js";
import { loadState } from "./state.js";
import { NO_SYSTEM_STORE_SENTENCE } from "./trust.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 9): `pnpm voice:check`, a report of whether everything a voice session needs is in place. One line
 * per result, prefixed OK, WARN, FAIL or SKIP, then a summary; exit 0 with no FAIL, 1 with any, 2 for bad settings.
 *
 * Read-only: it reads `.env` through `loadRootEnv` (never writes it, never runs git), never creates the state folder, never mints a
 * participant token (the key check signs a 60 s server API token for ListRooms only), never reads a container log, and observes a
 * running whisper-server without changing it. No secret is printed: every line is fixed text plus the mode, the hostname, ports,
 * addresses, the model label, days to expiry and versions; the STT URL (its path is a secret), the keys and every `.env` value stay out.
 */

export type CheckDeps = OpsDeps & {
  resolve4: (h: string) => Promise<string[]>; resolve6: (h: string) => Promise<string[]>;
  lookup: (h: string) => Promise<{ address: string; family: number }[]>;
  statfs: (p: string) => { bavail: number; bsize: number };
  tcpConnect: (host: string, port: number) => Promise<"open" | "refused" | "timeout">;
  platform: NodeJS.Platform; whisperPath: () => string | null;
  /** The whisper-server CORS probe (default: an OPTIONS request on loopback). */
  corsOrigin?: (u: URL) => Promise<string | null | undefined>;
  /** The key check's request (default: `loopbackRequest`; tests point it at a stand-in, LIVEKIT_HOST stays the default). */
  keysRequest?: KeysRequest;
};

const PREFIX: Record<CheckResult["level"], string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "SKIP" };
const MAX_CERT_BYTES = 1024 * 1024;

/** A small file read through one O_NOFOLLOW-free descriptor (a certificate may be a link), at most 1 MiB; null when unreadable. */
function readSmall(file: string): string | null {
  try {
    const fd = openSync(file, fsConstants.O_RDONLY);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_CERT_BYTES) return null;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
      return buf.subarray(0, off).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }
}

export async function voiceCheck(d: CheckDeps): Promise<0 | 1 | 2> {
  let merged: NodeJS.ProcessEnv;
  try { merged = loadRootEnv(d.repoRoot, d.env); } catch (err) { d.out(`voice:check: ${(err as Error).message}`); return 2; }
  const parsed = parseVoiceOpsSettings(merged, { home: d.home, repoRoot: d.repoRoot });
  if (!parsed.ok) { for (const e of parsed.errors) d.out(`voice:check: ${e}`); return 2; }
  const s = parsed.s;
  const results: CheckResult[] = [];
  const add = (r: CheckResult | CheckResult[]): void => { for (const x of Array.isArray(r) ? r : [r]) { results.push(x); d.out(`${PREFIX[x.level]} ${x.line}`); } };
  /** Each check on its own: one that throws is a FAIL line, and the others still run. */
  const guarded = async (name: string, f: () => Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[]): Promise<void> => {
    try { add(await f()); } catch { add({ name, level: "fail", line: `${name}: the check failed unexpectedly` }); }
  };

  // the state voice:up left, and the node address LiveKit advertises
  const loaded = loadState(s.stateDir);
  const node = nodeAddress(s, d.interfaces());
  if (loaded.status === "ok" && node.ok && loaded.state.nodeIp !== node.ip) add({ name: "node-address", level: "fail", line: "the node address changed since voice:up: run pnpm voice:down and pnpm voice:up" });
  if (loaded.status === "unreadable") add({ name: "state", level: "fail", line: "the voice state is unreadable: run pnpm voice:down, then pnpm voice:up" });
  if (!node.ok) add({ name: "node-address", level: "fail", line: node.error });
  const nodeIp = node.ok ? node.ip : "127.0.0.1";
  // Review B2 F11 (a): the report reads the merged view, which hides a managed name exported in this shell; voice:up refuses that.
  for (const name of MANAGED_NAMES) if (d.env[name] !== undefined) add({ name: "shell", level: "warn", line: `${name} is set in this shell: voice:up refuses to start until it is unset (control would read it instead of .env)` });
  const running = loaded.status === "ok" && loaded.state.compose !== undefined;

  const docker = await dockerProblem(d.env, d.run);
  add(docker ? { name: "docker", level: "fail", line: docker } : { name: "docker", level: "ok", line: "Docker: a local engine with Compose 2.24.0 or newer" });

  const stt = merged.STT_URL !== undefined ? parseSttUrl(merged.STT_URL) : null;
  const sttUrl = stt?.ok ? stt.url : null;
  await guarded("whisper", () => (sttUrl ? whisperCheck({ sttUrl, health: d.health, ...(d.corsOrigin ? { corsOrigin: d.corsOrigin } : {}) })
    : [{ name: "whisper", level: "fail", line: "STT_URL is not set (or not valid) in .env: run pnpm voice:up" }]));
  await guarded("livekit", () => livekitCheck({ host: s.livekitHost, answers: d.answers }));
  // Review B2 F11 (b): the admin token goes only to the address voice:up runs LiveKit on, never to another loopback LIVEKIT_HOST.
  if (s.livekitHost.origin !== DEFAULT_LIVEKIT_HOST) add({ name: "livekit-keys", level: "skip", line: `LIVEKIT_HOST is not ${DEFAULT_LIVEKIT_HOST}: the key check is skipped (voice:up runs LiveKit only there)` });
  else await guarded("livekit-keys", () => livekitKeysCheck({ host: s.livekitHost, key: merged.LIVEKIT_API_KEY, secret: merged.LIVEKIT_API_SECRET, now: d.now(), ...(d.keysRequest ? { request: d.keysRequest } : {}) }));

  const lan = s.access === "lan" ? s.lan : undefined;
  if (lan) {
    if (!d.systemTrust) add({ name: "trust-store", level: "warn", line: NO_SYSTEM_STORE_SENTENCE }); // review B2 F9
    await guarded("certificate", () => {
      const certFile = lan.tls.mode === "files" ? lan.tls.certFile : caddyManagedCert(s.stateDir, lan.hostname);
      const keyMode = ((): number | null => { if (lan.tls.mode !== "files") return 0o600; try { return statSync(lan.tls.keyFile).mode; } catch { return null; } })();
      return certificateCheck({ certPem: certFile === null ? null : readSmall(certFile), keyMode, hostname: lan.hostname, now: d.now() });
    });
    const ownAddresses = Object.values(d.interfaces()).flatMap((l) => (l ?? []).map((i) => i.address));
    await guarded("dns", () => dnsCheck({ hostname: lan.hostname, nodeIp, resolve4: d.resolve4, resolve6: d.resolve6, lookup: d.lookup, ownAddresses }));
    await guarded("tls-route", () => tlsRouteCheck({ hostname: lan.hostname, port: lan.livekitTlsPort, connect: d.tlsConnect }));
  }
  await guarded("web", () => webCheck({
    webPort: s.webPort, lanAddresses: lanAddressesOf(d.interfaces()), connect: d.tcpConnect,
    ...(lan ? { viaProxy: async () => { const r = await d.tlsConnect(lan.hostname, lan.httpsPort, lan.hostname); return r.authorized ? r.status : null; } } : {}),
  }));
  await guarded("disk", () => diskCheck({ dirs: [...(s.audioDir ? [s.audioDir] : []), s.stateDir], minFreeMb: s.audioMinFreeMb, statfs: d.statfs }));
  const wanted: { host: string; port: number; proto: "tcp" | "udp"; label: string }[] = [];
  if (sttUrl) wanted.push({ host: "127.0.0.1", port: Number(sttUrl.port), proto: "tcp", label: "whisper-server, STT_URL" });
  wanted.push({ host: "127.0.0.1", port: 7880, proto: "tcp", label: "LiveKit API" }, { host: nodeIp, port: 7881, proto: "tcp", label: "LiveKit media TCP" }, { host: nodeIp, port: 7882, proto: "udp", label: "LiveKit media UDP" });
  if (lan) wanted.push({ host: nodeIp, port: lan.httpsPort, proto: "tcp", label: "HTTPS proxy" }, { host: nodeIp, port: lan.livekitTlsPort, proto: "tcp", label: "LiveKit TLS proxy" });
  await guarded("ports", () => portsCheck({ running, wanted, portFree: d.portFree }));
  await guarded("backup", () => backupCheck({
    platform: d.platform, run: d.run,
    dirs: [...(s.audioDir ? [{ label: "the audio folder (AUDIO_DIR)", dir: s.audioDir }] : []), { label: "the state folder (VOICE_STATE_DIR)", dir: s.stateDir }],
  }));
  await guarded("versions", () => {
    let composeText: string | null = null;
    try { composeText = readFileSync(path.join(d.repoRoot, COMPOSE_FILE), "utf8"); } catch { composeText = null; }
    return versionsCheck({ run: d.run, env: d.env, docker: docker === null, modelLabel: s.model.label, whisperPath: d.whisperPath(), composeText, node: process.version });
  });

  d.out(lan
    ? `voice:check: participants open https://${lan.hostname}${lan.httpsPort === 443 ? "" : `:${lan.httpsPort}`}; a plain http:// LAN address cannot use the microphone`
    : `voice:check: only this machine's browser can use the microphone: http://localhost:${s.webPort}`);
  const count = (l: CheckResult["level"]): number => results.filter((r) => r.level === l).length;
  d.out(`voice:check: ${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip`);
  return count("fail") > 0 ? 1 : 0;
}
