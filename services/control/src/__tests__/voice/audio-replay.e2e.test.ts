import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlEventLog } from "../../../../runtime/src/engine/event-log.js";
import { AudioStore } from "../../../../speech/src/store/audio-store.js";
import { createApi } from "../../api.js";
import type { ControlConfig } from "../../config.js";
import { buildAudioService, startControl, type RunningControl } from "../../main.js";
import { AuditLog } from "../../voice/audit-log.js";
import { makeAcquireLock, sweepAudio } from "../../voice/sweep.js";
import type { SpawnFn } from "../../supervisor.js";

/**
 * US-0074 (voice A2b-1a, Task 8): the audio listing and replay end to end. The REAL speech `AudioStore` writes the session marker, the WAV
 * and the index line on a private temp dir; the REAL control API (`createApi` with the service main.ts builds, `buildAudioService`, and
 * once the whole `startControl` with VOICE_ENABLED=0) answers over real HTTP; the REAL `AuditLog` writes the `audio.played` lines and the
 * REAL `sweepAudio` (on an injected clock) expires a folder. Nothing in between is faked.
 */
const DAY_MS = 86_400_000;
const T0 = 1_800_000_000_000;
const TOKEN = "e".repeat(40);
const BY = "kamal-console";
const S = "session-1", S2 = "session-2";
const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa1), B = id(0xb2), C = id(0xc3), D = id(0xd4);

let root = "";
let audioDir = "";
let sessionsDir = "";
const servers: http.Server[] = [];
let running: RunningControl | undefined;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "acr-replay-e2e-"));
  audioDir = path.join(root, "audio");
  sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  rmSync(root, { recursive: true, force: true });
});

/** A distinct 0.25 s 16 kHz tone per seed, so two segments never share bytes. */
const pcm = (seed: number): Int16Array => Int16Array.from({ length: 4000 }, (_, i) => Math.round(8000 * Math.sin((i * (seed + 1)) / 9)));

/** The REAL worker store for one identity: writes the marker before the first WAV, then each WAV and its index line; optionally ended.json. */
function record(o: { identity: string; sessionId: string; segments: { role: string; segment: string; seed: number; seq?: number }[]; at?: number; ended?: boolean; dir?: string }): void {
  const stops: string[] = [];
  const store = new AudioStore({
    audioDir: o.dir ?? audioDir, logIdentity: o.identity, sessionId: o.sessionId, sessionsDir, minFreeMb: 512, now: () => o.at ?? T0,
    lock: { lost: false }, onStopped: (r) => stops.push(r),
  });
  for (const s of o.segments) {
    const r = store.write({
      roleId: s.role, participantId: `p-${s.segment}`, segmentId: s.segment, startMs: 1000 * s.seed, endMs: 1000 * s.seed + 250,
      pcm: pcm(s.seed), outcome: { kind: "accepted" }, ...(s.seq !== undefined ? { seq: s.seq } : {}), raw: "words somebody said",
    });
    expect(r).toBe("written");
  }
  if (o.ended) store.markEnded();
  expect(stops).toEqual([]);
}
const wavOnDisk = (identity: string, role: string, segment: string, dir = audioDir) => readFileSync(path.join(dir, identity, role, `${segment}.wav`));
const auditLines = (identity: string, dir = audioDir): Record<string, unknown>[] => {
  let text: string;
  try { text = readFileSync(path.join(dir, `${identity}.audio-audit.jsonl`), "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};
const played = (identity: string, dir = audioDir) => auditLines(identity, dir).filter((l) => l.type === "audio.played");

/** A real session log as the runtime writes it (the runtime's own JsonlEventLog): `session.started` first, naming `logIdentity`. */
async function sessionLog(sessionId: string, logIdentity: string, dir = sessionsDir): Promise<void> {
  const log = new JsonlEventLog(sessionId, dir, { sync: false });
  await log.append({ type: "session.started", scenarioId: "sc", version: "1", roles: {}, logFormat: 3, logIdentity } as never, T0);
  await log.append({ type: "scene.entered", sceneId: "a", participants: [] } as never, T0 + 1);
  await log.close?.();
}

/** The control API main.ts builds (its `buildAudioService`, the real AuditLog), on a real loopback port. */
async function boot(now: () => number = () => T0 + 5) {
  const audit = new AuditLog({ audioDir, now, log: () => {} });
  const audio = buildAudioService({ audioDir, sessionsDir }, { audit });
  const untouchable = new Proxy({}, { get: () => { throw new Error("the audio routes must not use the supervisor"); } });
  const server = http.createServer(createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: untouchable as never, scenarios: () => Promise.resolve([]), audio,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return client((server.address() as AddressInfo).port);
}
function client(port: number) {
  return async (p: string, headers: Record<string, string> = { "x-acr-by": BY }) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-service-token": TOKEN, ...headers } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };
}
type Listing = { identities: number; recordingStopped: boolean; segments: { identity: string; role: string; segment: string; audio: string }[] };
const listing = (b: Buffer): Listing => (JSON.parse(b.toString("utf8")) as { data: Listing }).data;
const sweep = (now: number) => {
  const audit = new AuditLog({ audioDir, now: () => now, log: () => {} });
  return sweepAudio({ audioDir, retentionDays: 30, now: () => now, audit, acquireLock: makeAcquireLock(() => {}), log: () => {} });
};

describe("audio replay end to end: real worker store, real control API, real audit and sweep (US-0074, Task 8)", () => {
  it("the listing shows the session's segment, and not another session's", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1, seq: 4 }] });
    record({ identity: B, sessionId: S2, segments: [{ role: "coach", segment: "seg9", seed: 9 }] });
    const get = await boot();
    const r = await get(`/sessions/${S}/audio`);
    expect(r.status).toBe(200);
    expect(listing(r.body)).toStrictEqual({
      identities: 1, recordingStopped: false,
      segments: [{ identity: A, role: "coach", segment: "seg1", participantId: "p-seg1", startMs: 1000, endMs: 1250, status: "transcribed", seq: 4, audio: "available" }],
    });
    expect(r.body.toString("utf8")).not.toContain("words somebody said");
    const other = listing((await get(`/sessions/${S2}/audio`)).body);
    expect(other.segments.map((s) => [s.identity, s.segment])).toEqual([[B, "seg9"]]);
  });

  it("a replay returns the exact WAV bytes and writes exactly one audio.played line (name, role, segment, no other keys); a second adds a second", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    const get = await boot(() => T0 + 7);
    expect(auditLines(A)).toEqual([]);
    const r = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(r.status).toBe(200);
    const disk = wavOnDisk(A, "coach", "seg1");
    expect(r.body.equals(disk)).toBe(true);
    expect(r.body.toString("ascii", 0, 4)).toBe("RIFF");
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(r.headers.get("content-length")).toBe(String(disk.length));
    expect(auditLines(A)).toStrictEqual([{ v: 1, ts: T0 + 7, type: "audio.played", role: "coach", segment: "seg1", by: BY }]);
    const again = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(again.status).toBe(200);
    expect(again.body.equals(disk)).toBe(true);
    expect(played(A)).toStrictEqual([
      { v: 1, ts: T0 + 7, type: "audio.played", role: "coach", segment: "seg1", by: BY },
      { v: 1, ts: T0 + 7, type: "audio.played", role: "coach", segment: "seg1", by: BY },
    ]);
  });

  it("two identities for one session (a restart rotated the log): the listing shows both, a replay finds each segment where it is, each audit line in the holding identity's file", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    record({ identity: B, sessionId: S, segments: [{ role: "coach", segment: "seg2", seed: 2 }, { role: "client", segment: "seg3", seed: 3 }] });
    const get = await boot();
    const l = listing((await get(`/sessions/${S}/audio`)).body);
    expect(l.identities).toBe(2);
    expect(l.segments.map((s) => [s.identity, s.role, s.segment, s.audio])).toEqual([
      [A, "coach", "seg1", "available"], [B, "client", "seg3", "available"], [B, "coach", "seg2", "available"],
    ]);
    const r1 = await get(`/sessions/${S}/audio/coach/seg1`);
    const r2 = await get(`/sessions/${S}/audio/coach/seg2`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.equals(wavOnDisk(A, "coach", "seg1"))).toBe(true);
    expect(r2.body.equals(wavOnDisk(B, "coach", "seg2"))).toBe(true);
    expect(r1.body.equals(r2.body)).toBe(false);
    expect(played(A).map((x) => x.segment)).toEqual(["seg1"]);
    expect(played(B).map((x) => x.segment)).toEqual(["seg2"]);
  });

  it("after the real sweep expires the folder (clock past retention) the listing and the replay are 404 and no audio.played is written", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }], ended: true });
    const get = await boot();
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(200);
    expect(await sweep(T0 + 30 * DAY_MS - 1)).toMatchObject({ deleted: 0 });
    expect((await get(`/sessions/${S}/audio`)).status).toBe(200);
    expect(await sweep(T0 + 30 * DAY_MS)).toMatchObject({ deleted: 1 });
    const l = await get(`/sessions/${S}/audio`);
    expect(l.status).toBe(404);
    expect(l.headers.get("content-type")).toBe("application/json");
    const r = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(auditLines(A).map((x) => x.type)).toEqual(["audio.played", "audio.deleted"]); // the one replay before, then the sweep
  });

  it("a pre-marker folder (no session.json) is found through the session log's first line naming its identity", async () => {
    record({ identity: C, sessionId: S, segments: [{ role: "coach", segment: "seg5", seed: 5 }] });
    unlinkSync(path.join(audioDir, C, "session.json")); // as a worker from before markers left it
    const get = await boot();
    expect((await get(`/sessions/${S}/audio`)).status).toBe(404); // no marker and no log yet
    await sessionLog(S, C);
    const l = listing((await get(`/sessions/${S}/audio`)).body);
    expect(l.segments.map((s) => [s.identity, s.segment])).toEqual([[C, "seg5"]]);
    const r = await get(`/sessions/${S}/audio/coach/seg5`);
    expect(r.status).toBe(200);
    expect(r.body.equals(wavOnDisk(C, "coach", "seg5"))).toBe(true);
    expect(played(C).map((x) => [x.segment, x.by])).toEqual([["seg5", BY]]);
  });

  it("the fallback is ignored when the session log names a folder whose marker names another session", async () => {
    record({ identity: D, sessionId: S2, segments: [{ role: "coach", segment: "seg6", seed: 6 }] });
    await sessionLog(S, D); // a stale or wrong logIdentity
    const get = await boot();
    expect((await get(`/sessions/${S}/audio`)).status).toBe(404);
    expect((await get(`/sessions/${S}/audio/coach/seg6`)).status).toBe(404);
    expect(played(D)).toEqual([]);
    expect(listing((await get(`/sessions/${S2}/audio`)).body).segments.map((s) => s.segment)).toEqual(["seg6"]); // still its own session's
  });

  it("the whole startControl with VOICE_ENABLED=0 still lists and replays (marker and pre-marker fallback) and audits", async () => {
    const data = path.join(root, "data");
    const dir = path.join(data, "audio"); // the default AUDIO_DIR, <dataDir>/audio
    const logs = path.join(data, "sessions"); // config.sessionsDir
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(root, "scenarios"), { recursive: true });
    const now = Date.now(); // the start-up sweep runs on the real clock: this audio is fresh
    record({ dir, identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }], at: now, ended: true });
    record({ dir, identity: C, sessionId: S2, segments: [{ role: "coach", segment: "seg5", seed: 5 }], at: now, ended: true });
    unlinkSync(path.join(dir, C, "session.json"));
    await sessionLog(S2, C, logs);
    running = await startControl(
      { CONTROL_DATA_DIR: data, LAUNCHER_TOKEN: TOKEN, SCENARIOS_DIR: path.join(root, "scenarios"), CONTROL_GRACE_MS: "200", VOICE_ENABLED: "0" },
      { port: 0, spawn: (() => { throw new Error("no spawn"); }) as unknown as SpawnFn },
    );
    const get = client(running.port);
    expect(listing((await get(`/sessions/${S}/audio`)).body).segments.map((s) => s.segment)).toEqual(["seg1"]);
    const r = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(r.status).toBe(200);
    expect(r.body.equals(wavOnDisk(A, "coach", "seg1", dir))).toBe(true);
    expect(played(A, dir).map((x) => [x.role, x.segment, x.by])).toEqual([["coach", "seg1", BY]]);
    const f = await get(`/sessions/${S2}/audio/coach/seg5`);
    expect(f.status).toBe(200);
    expect(f.body.equals(wavOnDisk(C, "coach", "seg5", dir))).toBe(true);
    expect((await get(`/sessions/${S}/audio`, {})).status).toBe(400); // the X-Acr-By rule is wired too
  });

  it("US-0075: the whole startControl wires DELETE /sessions/:id/audio (real lock acquirer, no voice host so never live): deleted, then 410", async () => {
    const data = path.join(root, "data");
    const dir = path.join(data, "audio");
    mkdirSync(path.join(data, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(root, "scenarios"), { recursive: true });
    record({ dir, identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }], at: Date.now(), ended: true });
    running = await startControl(
      { CONTROL_DATA_DIR: data, LAUNCHER_TOKEN: TOKEN, SCENARIOS_DIR: path.join(root, "scenarios"), CONTROL_GRACE_MS: "200", VOICE_ENABLED: "0" },
      { port: 0, spawn: (() => { throw new Error("no spawn"); }) as unknown as SpawnFn },
    );
    const r = await fetch(`http://127.0.0.1:${running.port}/sessions/${S}/audio`, {
      method: "DELETE", headers: { "x-service-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ scope: { kind: "session" }, reason: "facilitator", by: BY }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toStrictEqual({ deleted: 1, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }], pending: [] });
    expect(existsSync(path.join(dir, A, "coach", "seg1.wav"))).toBe(false);
    expect(auditLines(A, dir).filter((l) => l.type === "audio.deleted").map((l) => [l.reason, l.by, l.segments])).toEqual([["facilitator", BY, 1]]);
    expect((await client(running.port)(`/sessions/${S}/audio/coach/seg1`)).status).toBe(410);
  });
});
