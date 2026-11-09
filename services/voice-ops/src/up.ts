import { closeSync, constants as fsConstants, fstatSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { composeArgs, composeEnv, dockerProblem, nodeAddress, removeLiveKitEnv, writeLiveKitEnv, COMPOSE_PROJECT } from "./compose.js";
import { ensureVoiceSecrets, EnvFileError, MANAGED_NAMES, trackedByGit } from "./env-file.js";
import { alive, cleanStaleTemps, LOCK_BUSY_SENTENCE, sentenceOf, wait, type OpsDeps } from "./ops.js";
import { isOurWhisper } from "./run.js";
import { DEFAULT_LIVEKIT_HOST, loadRootEnv, parseVoiceOpsSettings, type VoiceOpsSettings } from "./settings.js";
import { acquireLock, clearState, loadState, openPrivateSubdir, openStateDir, releaseLock, writeState, type VoiceOpsState } from "./state.js";
import type { RollbackOutcome } from "./signals.js";
import { tlsRouteAnswers } from "./tls-route.js";
import { checkModelFile, startWhisper, stopSpawned, WHISPER_READY_WAIT_MS, WHISPER_POLL_MS, WHISPER_STOP_GRACE_MS, WhisperStartError } from "./whisper.js";
import type { SpawnedChild } from "./run.js";

export type { OpsDeps, PortProbe } from "./ops.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 7): `pnpm voice:up`. The order (plan Revision 2; each refusal is one fixed sentence, exit 1,
 * nothing started, `.env` unchanged): settings (exit 2); the REAL environment setting a managed name; the state directory and the lock;
 * the existing state (fresh, repair, "already running" or a refusal); dns mode; `.env` tracked by git; the model file; Docker; the node
 * address; the lan certificate files; THEN the secrets (`ensureVoiceSecrets` with the real environment) and the merged view read again;
 * the ports; then `livekit.env`, the state, whisper-server, compose, the LiveKit wait and (lan) the TLS route.
 *
 * Rollback, on any failure or interrupt after this run's first change (livekit.env, the state, a start; review B2 F1: a refusal or an
 * interrupt before that changes nothing, so a running stack keeps the state voice:down needs): compose down (after `dockerProblem`) if this run started
 * compose on a fresh start, whisper-server through its own spawn handle, then (fresh) `livekit.env` and the state. Repair mode never runs
 * compose down and never stops a whisper-server it did not start. An interrupt is handled once; the interrupt handler only sets a flag
 * and aborts the waits and the running `compose up` (review B2 F6: its run settles only after docker compose has exited, so `down`
 * never races `up`), the main flow does the rollback (so a second Ctrl-C cannot start a second rollback).
 *
 * Nothing printed holds a secret: the lines are fixed sentences plus the mode, the hostname, ports, the node address and the model label.
 */

export const LIVEKIT_READY_WAIT_MS = 60_000;
export const LIVEKIT_POLL_MS = 1_000;
/** The first `compose up` pulls the images: far above realRun's 120 s default. */
export const COMPOSE_UP_TIMEOUT_MS = 600_000;
export const COMPOSE_DOWN_TIMEOUT_MS = 120_000;

const NEXT_STEPS_VOICE_OFF = "Voice stays off until VOICE_ENABLED=1 and CONSENT_NOTICE_VERSION=v3 (pre-production only; docs/VOICE_RUNBOOK.md)";

class Stop extends Error { constructor(readonly code: 0 | 1 | 2, readonly line?: string) { super("stop"); } }
class Interrupted extends Error { constructor() { super("interrupted"); } }

type Ports = VoiceOpsState["ports"];

function wantedPorts(s: VoiceOpsSettings, stt: number): Ports {
  const p: Ports = { stt, livekit: 7880, tcp: 7881, udp: 7882 };
  if (s.access === "lan" && s.lan) { p.https = s.lan.httpsPort; p.livekitTls = s.lan.livekitTlsPort; }
  return p;
}
const profilesOf = (s: VoiceOpsSettings): string[] => (s.access === "lan" ? ["lan"] : []);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function sameSettings(st: VoiceOpsState, access: string, nodeIp: string, ports: Ports, profiles: string[]): boolean {
  const norm = (p: Ports): Ports => ({ stt: p.stt, livekit: p.livekit, tcp: p.tcp, udp: p.udp, ...(p.https !== undefined ? { https: p.https } : {}), ...(p.livekitTls !== undefined ? { livekitTls: p.livekitTls } : {}) });
  return st.access === access && st.nodeIp === nodeIp && sameJson(norm(st.ports), norm(ports)) && sameJson([...st.profiles].sort(), [...profiles].sort());
}

/** The STT port of the merged view's STT_URL, or null (absent or not a URL: the writer judges it later). */
function sttPortOf(merged: NodeJS.ProcessEnv): number | null {
  try { const u = new URL(merged.STT_URL ?? ""); const n = Number(u.port); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}

/** lan, files mode: the certificate readable, the key readable and with no group or other bit. A fixed sentence naming the variable. */
function certificateProblem(certFile: string, keyFile: string): string | null {
  const readable = (f: string): boolean => {
    try { const fd = openSync(f, fsConstants.O_RDONLY); try { return fstatSync(fd).isFile(); } finally { closeSync(fd); } } catch { return false; }
  };
  if (!readable(certFile)) return "VOICE_TLS_CERT_FILE cannot be read: give the absolute path of your certificate file (PEM, full chain)";
  if (!readable(keyFile)) return "VOICE_TLS_KEY_FILE cannot be read: give the absolute path of your private key file (PEM)";
  if ((statSync(keyFile).mode & 0o077) !== 0) return "VOICE_TLS_KEY_FILE is readable by other users: run chmod 600 on it, then pnpm voice:up";
  return null;
}

export type UpOutcome = { code: 0 | 1 | 2; rollback: RollbackOutcome };

export async function voiceUp(d: OpsDeps): Promise<0 | 1 | 2> { return (await voiceUpOutcome(d)).code; }

/** `voiceUp` plus what its rollback did (review B2 F3: the CLI says "rolled back" only after a rollback that completed). */
export async function voiceUpOutcome(d: OpsDeps): Promise<UpOutcome> {
  const say = (l: string): void => d.out(`voice:up: ${l}`);
  const none = (code: 0 | 1 | 2): UpOutcome => ({ code, rollback: "none" });
  // 1. settings, from the merged view control reads
  let merged: NodeJS.ProcessEnv;
  try { merged = loadRootEnv(d.repoRoot, d.env); } catch (err) { say((err as Error).message); return none(2); }
  const parsed = parseVoiceOpsSettings(merged, { home: d.home, repoRoot: d.repoRoot });
  if (!parsed.ok) { for (const e of parsed.errors) say(e); return none(2); }
  const s = parsed.s;
  if (s.livekitHost.origin !== DEFAULT_LIVEKIT_HOST) { say(`LIVEKIT_HOST must be ${DEFAULT_LIVEKIT_HOST} for voice:up (voice.yml publishes LiveKit's API on exactly that address)`); return none(2); }
  // 2. the real environment must not set a managed name (control would read it instead of .env: finding 7)
  for (const name of MANAGED_NAMES) if (d.env[name] !== undefined) { say(`unset ${name} in this shell: voice:up and control must read it from .env`); return none(1); }
  // 3. the state directory and the lock
  try { openStateDir(s.stateDir, { repoRoot: d.repoRoot }); } catch (err) { say(sentenceOf(err, "VOICE_STATE_DIR cannot be used")); return none(1); }
  if (acquireLock(s.stateDir, d.pid, (p) => alive(d.kill, p)) === "busy") { say(LOCK_BUSY_SENTENCE); return none(1); }
  try {
    cleanStaleTemps({ repoRoot: d.repoRoot, stateDir: s.stateDir, say });
    return await upLocked(d, s, merged, say);
  } finally { releaseLock(s.stateDir, d.pid); }
}

async function upLocked(d: OpsDeps, s: VoiceOpsSettings, merged0: NodeJS.ProcessEnv, say: (l: string) => void): Promise<UpOutcome> {
  const ctl = new AbortController();
  let interrupted = false;
  const unhook = d.onInterrupt(() => { if (interrupted) return; interrupted = true; ctl.abort(); });
  const checkpoint = (): void => { if (interrupted) throw new Interrupted(); };

  // What THIS run started, for the rollback.
  let mode: "fresh" | "repair" = "fresh";
  let state: VoiceOpsState | null = null;
  let whisperChild: SpawnedChild | null = null;
  let composeStarted = false;
  let wroteLiveKitEnv = false;
  // Review B2 F1: whether this run changed anything (a file of the state directory or a process). Every refusal and interrupt before
  // the first change leaves the running stack's state and livekit.env exactly as they are: no rollback, nothing cleared.
  let touched = false;
  let createdState = false;
  const save = (): void => { if (state) { touched = true; writeState(s.stateDir, state); } };

  try {
    const profiles = profilesOf(s);
    // 4. the existing state
    const loaded = loadState(s.stateDir);
    if (loaded.status === "unreadable") throw new Stop(1, "the voice state is unreadable: run pnpm voice:down, then pnpm voice:up");
    const node = nodeAddress(s, d.interfaces());
    let restartWhisper = true;
    if (loaded.status === "ok") {
      const st = loaded.state;
      const sttPort = sttPortOf(merged0);
      if (!node.ok || sttPort === null || !sameSettings(st, s.access, node.ip, wantedPorts(s, sttPort), profiles)) throw new Stop(1, "settings changed: run pnpm voice:down first");
      const sttUrl = new URL(merged0.STT_URL!);
      const ident = st.whisper !== undefined ? await isOurWhisper(st.whisper, d.run) : "not_ours";
      if (ident === "unknown") throw new Stop(1, "could not identify the recorded whisper-server: run pnpm voice:up again"); // review B2 F4
      const ours = ident === "ours";
      const healthy = ours && (await d.health(sttUrl)) === "ok";
      const livekitUp = await d.answers(s.livekitHost.href);
      const proxyUp = s.access !== "lan" || !s.lan ? true
        : await tlsRouteAnswers({ hostname: s.lan.hostname, port: s.lan.livekitTlsPort, address: node.ip, connect: d.tlsConnect });
      checkpoint();
      if (healthy && livekitUp && proxyUp) { say("already running"); return { code: 0, rollback: "none" }; }
      mode = "repair";
      state = { ...st };
      if (ours) { restartWhisper = false; delete state.whisper; state.whisper = st.whisper; }
      else delete state.whisper;
      say("repairing: starting what is not running");
    }
    // 5. dns mode waits for Task 13
    if (s.lan?.tls.mode === "dns") throw new Stop(1, "VOICE_TLS_MODE=dns is not available yet: use VOICE_TLS_MODE=files with your own certificate (docs/VOICE_RUNBOOK.md)");
    // 6. a tracked .env (the writer checks it again; this keeps the refusal before the model and Docker checks)
    try { if (await trackedByGit(d.run, d.repoRoot, d.env)) throw new EnvFileError("tracked"); }
    catch (err) { if (err instanceof EnvFileError) throw new Stop(1, err.message); throw err; }
    checkpoint();
    // 7. the model file (only needed when whisper-server is started)
    if (restartWhisper) {
      const m = checkModelFile(s.model.file, s.model.label);
      if (!m.ok) throw new Stop(1, m.error);
      if (m.warning) say(m.warning);
    }
    // 8. Docker: Compose 2.24.0+, a local engine only
    const docker = await dockerProblem(d.env, d.run);
    if (docker) throw new Stop(1, docker);
    checkpoint();
    // 9. the node address
    if (!node.ok) throw new Stop(1, node.error);
    const nodeIp = node.ip;
    // 10. lan: the certificate files
    if (s.access === "lan" && s.lan?.tls.mode === "files") {
      const c = certificateProblem(s.lan.tls.certFile, s.lan.tls.keyFile);
      if (c) throw new Stop(1, c);
    }
    // 11. THEN the secrets, with the REAL environment (the merged view holds them after the first run), and the merged view again
    try {
      const r = await ensureVoiceSecrets({ file: path.join(d.repoRoot, ".env"), random: d.random, freePort: d.freePort, now: d.now, env: d.env, run: d.run });
      if (r.added.length > 0) say(`added to .env: ${r.added.join(", ")}`);
    } catch (err) { if (err instanceof EnvFileError) throw new Stop(1, err.message); throw err; }
    checkpoint();
    let merged: NodeJS.ProcessEnv;
    try { merged = loadRootEnv(d.repoRoot, d.env); } catch (err) { throw new Stop(1, (err as Error).message); }
    const sttUrl = new URL(merged.STT_URL!);
    const ports = wantedPorts(s, Number(sttUrl.port));
    // 12. the ports (repair: only the one whisper-server will take)
    const probes: { host: string; port: number; proto: "tcp" | "udp"; label: string }[] = [];
    if (restartWhisper) probes.push({ host: "127.0.0.1", port: ports.stt, proto: "tcp", label: "whisper-server, STT_URL" });
    if (mode === "fresh") {
      probes.push({ host: "127.0.0.1", port: 7880, proto: "tcp", label: "LiveKit API" }, { host: nodeIp, port: 7881, proto: "tcp", label: "LiveKit media TCP" }, { host: nodeIp, port: 7882, proto: "udp", label: "LiveKit media UDP" });
      if (ports.https !== undefined) probes.push({ host: nodeIp, port: ports.https, proto: "tcp", label: "HTTPS proxy" });
      if (ports.livekitTls !== undefined) probes.push({ host: nodeIp, port: ports.livekitTls, proto: "tcp", label: "LiveKit TLS proxy" });
    }
    for (const p of probes) {
      const r = await d.portFree(p.host, p.port, p.proto);
      if (r === "taken") throw new Stop(1, p.port === ports.stt && p.label.startsWith("whisper") ? `port ${p.port} (${p.label}) is taken: free the port, or remove STT_URL from .env to pick a new one` : `port ${p.port} (${p.label}) is taken: free the port, then pnpm voice:up`);
      if (r === "denied") say(`cannot test port ${p.port} without privileges; Docker reports it if it is taken`);
    }
    checkpoint();

    // 13. start: livekit.env, the state, whisper-server, compose, the waits
    touched = true;
    writeLiveKitEnv(s.stateDir, merged);
    wroteLiveKitEnv = true;
    if (mode === "fresh") { state = { v: 1, access: s.access, nodeIp, ports, profiles }; createdState = true; }
    save();
    if (restartWhisper) {
      try {
        whisperChild = await startWhisper({
          spawnDetached: d.spawnDetached, run: d.run, kill: d.kill, env: d.env, stateDir: s.stateDir, sttUrl, modelFile: s.model.file,
          health: () => d.health(sttUrl), warm: () => d.warm(sttUrl), setTimer: d.setTimer, now: d.now, signal: ctl.signal,
          onStarted: (w) => { state!.whisper = { pid: w.pid, port: ports.stt, startedAt: w.startedAt, comm: w.comm }; save(); },
        });
      } catch (err) {
        if (err instanceof WhisperStartError && err.code === "not_stopped") throw new Stop(1, err.message); // the record stays: it may still run
        if (state) { delete state.whisper; save(); }
        if (err instanceof WhisperStartError && err.code === "interrupted") throw new Interrupted();
        throw new Stop(1, err instanceof WhisperStartError ? err.message : "whisper-server could not be started");
      }
    } else {
      await waitWhisperHealthy(d, sttUrl, ctl.signal);
    }
    checkpoint();
    say(`whisper-server ready on 127.0.0.1 (model ${s.model.label})`);

    if (s.access === "lan") { openPrivateSubdir(s.stateDir, "caddy-data"); openPrivateSubdir(s.stateDir, "caddy-config"); }
    say(s.access === "lan"
      ? "starting LiveKit and the TLS proxy with Docker Compose (the first start pulls two digest-pinned images; this can take a few minutes)"
      : "starting LiveKit with Docker Compose (the first start pulls a digest-pinned image; this can take a few minutes)");
    state!.compose = { project: COMPOSE_PROJECT, profiles };
    save(); // before the start: a crash during `up` leaves a record voice:down acts on
    composeStarted = true;
    const up = await d.run("docker", composeArgs(d.repoRoot, s.access, "up"), { env: composeEnv(d.env, s, nodeIp), timeoutMs: COMPOSE_UP_TIMEOUT_MS, signal: ctl.signal }).catch(() => null); // review B2 F6
    checkpoint();
    if (up === null || up.code !== 0) throw new Stop(1, `docker compose up failed${up?.code != null ? ` (exit ${up.code})` : ""}: see docker compose -p ${COMPOSE_PROJECT} logs`);

    const deadline = d.now() + LIVEKIT_READY_WAIT_MS;
    for (;;) {
      if (await d.answers(s.livekitHost.href)) break;
      checkpoint();
      if (d.now() >= deadline) throw new Stop(1, `LiveKit did not answer on 127.0.0.1:7880 within ${LIVEKIT_READY_WAIT_MS / 1000} s: see docker compose -p ${COMPOSE_PROJECT} logs livekit`);
      if ((await wait(d.setTimer, LIVEKIT_POLL_MS, ctl.signal)) === "aborted") throw new Interrupted();
    }
    checkpoint();
    say(`LiveKit ready (media on ${nodeIp}, TCP 7881, UDP 7882)`);
    if (s.access === "lan" && s.lan) {
      const ok = await tlsRouteAnswers({ hostname: s.lan.hostname, port: s.lan.livekitTlsPort, address: nodeIp, connect: d.tlsConnect });
      checkpoint();
      if (!ok) throw new Stop(1, `the TLS route https://${s.lan.hostname}:${s.lan.livekitTlsPort}/rtc did not answer with a trusted certificate: check the certificate, the hostname and docker compose -p ${COMPOSE_PROJECT} logs caddy`);
      say(`proxy ready for https://${s.lan.hostname}`);
    }
    say("next: set SPEECH_INGEST=livekit in .env for the control service");
    if (s.access === "lan" && s.lan) say(`next: start the web app with PUBLIC_ORIGIN=https://${s.lan.hostname}${s.lan.httpsPort === 443 ? "" : `:${s.lan.httpsPort}`} and LIVEKIT_URL=wss://${s.lan.hostname}:${s.lan.livekitTlsPort} (pnpm --filter @acr/web start)`);
    else say(`next: start the web app with PUBLIC_ORIGIN=http://localhost:${s.webPort} and LIVEKIT_URL=ws://127.0.0.1:7880 (pnpm --filter @acr/web start)`);
    say(NEXT_STEPS_VOICE_OFF);
    if (s.access === "local") say("local mode serves only this machine; the two-person room test needs lan mode");
    return { code: 0, rollback: "none" };
  } catch (err) {
    const isInterrupt = err instanceof Interrupted || interrupted;
    if (err instanceof Stop && err.line) say(err.line);
    else if (isInterrupt) say("interrupted: rolling back what this run started");
    else if (!(err instanceof Stop)) say(sentenceOf(err, "voice:up failed"));
    if (err instanceof Stop && err.code === 2) return { code: 2, rollback: "none" };
    if (!touched) return { code: 1, rollback: "none" };
    return { code: 1, rollback: (await rollback()) ? "complete" : "incomplete" };
  } finally { unhook(); }

  /** True when everything this run started was stopped and its files updated (review B2 F3). */
  async function rollback(): Promise<boolean> {
    let composeLeft = false;
    // compose first (fresh only: repair never takes a running LiveKit down)
    if (composeStarted && mode === "fresh") {
      const problem = await dockerProblem(d.env, d.run);
      // detached (review B2 F3): its own process group, so a second Ctrl-C to the terminal cannot cut the rollback's compose down
      const r = problem ? null : await d.run("docker", composeArgs(d.repoRoot, s.access, "down"), { env: composeEnv(d.env, s, state?.nodeIp ?? "127.0.0.1"), timeoutMs: COMPOSE_DOWN_TIMEOUT_MS, detached: true }).catch(() => null);
      if (r === null || r.code !== 0) { composeLeft = true; say(`${problem ? problem + "; " : ""}the compose services may still run: run pnpm voice:down`); }
      else if (state) delete state.compose;
    } else if (composeStarted && state && mode === "repair") {
      say("repair: LiveKit and the proxy were left as they are");
    }
    // then whisper-server, through this run's own handle
    let whisperLeft = false;
    if (whisperChild) {
      const r = await stopSpawned(whisperChild, { kill: d.kill, setTimer: d.setTimer, graceMs: WHISPER_STOP_GRACE_MS });
      if (r === "not_stopped") { whisperLeft = true; say("whisper-server could not be stopped: stop it by hand, then pnpm voice:down"); }
      else if (state) delete state.whisper;
    } else if (state?.whisper && mode === "fresh") {
      whisperLeft = true; // not_stopped from startWhisper: the record stays
    }
    try {
      if (mode === "fresh") {
        if (wroteLiveKitEnv && !composeLeft) removeLiveKitEnv(s.stateDir);
        if (!composeLeft && !whisperLeft && createdState) clearState(s.stateDir);
        else save();
      } else save();
    } catch (err) { say(sentenceOf(err, "the voice state could not be updated")); return false; }
    return !composeLeft && !whisperLeft;
  }
}

/** Repair mode: a whisper-server of ours that is not healthy yet gets the health wait only. */
async function waitWhisperHealthy(d: OpsDeps, sttUrl: URL, signal: AbortSignal): Promise<void> {
  const deadline = d.now() + WHISPER_READY_WAIT_MS;
  for (;;) {
    if ((await d.health(sttUrl)) === "ok") return;
    if (signal.aborted) throw new Interrupted();
    if (d.now() >= deadline) throw new Stop(1, `whisper-server did not report ready within ${WHISPER_READY_WAIT_MS / 1000} s: run pnpm voice:down, then pnpm voice:up`);
    if ((await wait(d.setTimer, WHISPER_POLL_MS, signal)) === "aborted") throw new Interrupted();
  }
}
