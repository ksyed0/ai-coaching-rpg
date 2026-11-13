import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { JsonlEventLog } from "../../../../runtime/src/engine/event-log.js";
import { AudioStore } from "../../../../speech/src/store/audio-store.js";
import { createApi } from "../../api.js";
import type { ControlConfig } from "../../config.js";
import { buildAudioService, startControl, type RunningControl } from "../../main.js";
import type { SpawnFn } from "../../supervisor.js";
import type { AudioService } from "../../voice/audio-routes.js";
import { AuditLog } from "../../voice/audit-log.js";
import { makeAcquireLock, sweepAudio } from "../../voice/sweep.js";

/**
 * The shared harness of the audio end-to-end tests (US-0074 replay, US-0075 delete): a private temp root per test, the REAL speech
 * `AudioStore` writing marker, WAVs and index lines, the REAL control API over real loopback HTTP, the REAL `AuditLog` and `sweepAudio`.
 * Not a test file itself (no `.test.ts`): each e2e file calls `useAudioE2e()` once at its top level.
 */
export const DAY_MS = 86_400_000;
export const T0 = 1_800_000_000_000;
export const TOKEN = "e".repeat(40);
export const BY = "kamal-console";
export const S = "session-1", S2 = "session-2";
export const id = (n: number): string => n.toString(16).padStart(32, "0");
export const A = id(0xa1), B = id(0xb2), C = id(0xc3), D = id(0xd4);
/** `startControl`'s test options: no runtime child is ever spawned. */
export const NO_SPAWN = { spawn: (() => { throw new Error("no spawn"); }) as unknown as SpawnFn };

/** A distinct 0.25 s 16 kHz tone per seed, so two segments never share bytes. */
export const pcm = (seed: number): Int16Array => Int16Array.from({ length: 4000 }, (_, i) => Math.round(8000 * Math.sin((i * (seed + 1)) / 9)));

export type Segment = { role: string; segment: string; seed: number; seq?: number; participant?: string };
export type Listing = { identities: number; recordingStopped: boolean; segments: { identity: string; role: string; segment: string; participantId: string; audio: string }[] };
export const listing = (b: Buffer): Listing => (JSON.parse(b.toString("utf8")) as { data: Listing }).data;
export type Response = { status: number; headers: Headers; body: Buffer };

export function client(port: number) {
  return async (p: string, headers: Record<string, string> = { "x-acr-by": BY }): Promise<Response> => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-service-token": TOKEN, ...headers } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };
}

export function useAudioE2e(prefix: string) {
  const ctx = { root: "", audioDir: "", sessionsDir: "", running: undefined as RunningControl | undefined };
  const servers: http.Server[] = [];
  beforeEach(() => {
    ctx.root = mkdtempSync(path.join(tmpdir(), prefix));
    ctx.audioDir = path.join(ctx.root, "audio");
    ctx.sessionsDir = path.join(ctx.root, "sessions");
    mkdirSync(ctx.sessionsDir, { recursive: true, mode: 0o700 });
  });
  afterEach(async () => {
    await ctx.running?.close();
    ctx.running = undefined;
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
    rmSync(ctx.root, { recursive: true, force: true });
  });

  /** The REAL worker store for one identity: writes the marker before the first WAV, then each WAV and its index line; optionally ended.json. */
  function record(o: { identity: string; sessionId: string; segments: Segment[]; at?: number; ended?: boolean; dir?: string }): void {
    const stops: string[] = [];
    const store = new AudioStore({
      audioDir: o.dir ?? ctx.audioDir, logIdentity: o.identity, sessionId: o.sessionId, sessionsDir: ctx.sessionsDir, minFreeMb: 512, now: () => o.at ?? T0,
      lock: { lost: false }, onStopped: (r) => stops.push(r),
    });
    for (const s of o.segments) {
      const r = store.write({
        roleId: s.role, participantId: s.participant ?? `p-${s.segment}`, segmentId: s.segment, startMs: 1000 * s.seed, endMs: 1000 * s.seed + 250,
        pcm: pcm(s.seed), outcome: { kind: "accepted" }, ...(s.seq !== undefined ? { seq: s.seq } : {}), raw: "words somebody said",
      });
      expect(r).toBe("written");
    }
    if (o.ended) store.markEnded();
    expect(stops).toEqual([]);
  }
  const wavPath = (identity: string, role: string, segment: string, dir = ctx.audioDir) => path.join(dir, identity, role, `${segment}.wav`);
  const wavOnDisk = (identity: string, role: string, segment: string, dir = ctx.audioDir) => readFileSync(wavPath(identity, role, segment, dir));
  const auditLines = (identity: string, dir = ctx.audioDir): Record<string, unknown>[] => {
    let text: string;
    try { text = readFileSync(path.join(dir, `${identity}.audio-audit.jsonl`), "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const played = (identity: string, dir = ctx.audioDir) => auditLines(identity, dir).filter((l) => l.type === "audio.played");
  const deletedLines = (identity: string, dir = ctx.audioDir) => auditLines(identity, dir).filter((l) => l.type === "audio.deleted");

  /** A real session log as the runtime writes it (the runtime's own JsonlEventLog): `session.started` first, naming `logIdentity`. */
  async function sessionLog(sessionId: string, logIdentity: string, dir = ctx.sessionsDir): Promise<void> {
    const log = new JsonlEventLog(sessionId, dir, { sync: false });
    await log.append({ type: "session.started", scenarioId: "sc", version: "1", roles: {}, logFormat: 3, logIdentity } as never, T0);
    await log.append({ type: "scene.entered", sceneId: "a", participants: [] } as never, T0 + 1);
    await log.close?.();
  }

  /** `audio` behind the real control API on a real loopback port (the supervisor is never touched by the audio routes). */
  async function serve(audio: AudioService): Promise<number> {
    const untouchable = new Proxy({}, { get: () => { throw new Error("the audio routes must not use the supervisor"); } });
    const server = http.createServer(createApi({
      config: { serviceToken: TOKEN } as ControlConfig, supervisor: untouchable as never, scenarios: () => Promise.resolve([]), audio,
    }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  /** The control API main.ts builds (its `buildAudioService`, the real AuditLog), on a real loopback port. */
  async function boot(now: () => number = () => T0 + 5) {
    const audit = new AuditLog({ audioDir: ctx.audioDir, now, log: () => {} });
    return client(await serve(buildAudioService({ audioDir: ctx.audioDir, sessionsDir: ctx.sessionsDir }, { audit })));
  }

  /** One real retention pass (its own audit log and a private mutex) on an injected clock. */
  const sweep = (now: number) => {
    const audit = new AuditLog({ audioDir: ctx.audioDir, now: () => now, log: () => {} });
    return sweepAudio({ audioDir: ctx.audioDir, retentionDays: 30, now: () => now, audit, acquireLock: makeAcquireLock(() => {}), log: () => {} });
  };

  /**
   * The folders of the whole service under `<root>/data` (created): `dir` is the default AUDIO_DIR `<data>/audio` (left for the store to
   * create), `logs` is config.sessionsDir.
   */
  function whole(): { data: string; dir: string; logs: string } {
    const data = path.join(ctx.root, "data");
    const logs = path.join(data, "sessions");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(ctx.root, "scenarios"), { recursive: true });
    return { data, dir: path.join(data, "audio"), logs };
  }

  /** The whole `startControl` with VOICE_ENABLED=0 on the `whole()` folders; closed after the test. Returns its port. */
  async function startWhole(): Promise<number> {
    ctx.running = await startControl(
      { CONTROL_DATA_DIR: whole().data, LAUNCHER_TOKEN: TOKEN, SCENARIOS_DIR: path.join(ctx.root, "scenarios"), CONTROL_GRACE_MS: "200", VOICE_ENABLED: "0" },
      { port: 0, ...NO_SPAWN },
    );
    return ctx.running.port;
  }

  return { ctx, record, wavPath, wavOnDisk, auditLines, played, deletedLines, sessionLog, serve, boot, sweep, whole, startWhole };
}
