import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { encodeWav } from "@acr/adapters";
import { loadControlConfig, type ControlConfig } from "../../config.js";
import { listScenarios } from "../../scenarios.js";
import { SessionList } from "../../session-list.js";
import { forkSpawn } from "../../spawn.js";
import { Supervisor, type SetTimer } from "../../supervisor.js";
import { AuditLog } from "../../voice/audit-log.js";
import { speechSpawn } from "../../voice/speech-spawn.js";
import { makeAcquireLock, sweepAudio } from "../../voice/sweep.js";
import { VoiceHost } from "../../voice/voice-host.js";

/**
 * US-0073 (voice A2a, Task 10): the audio store through the REAL processes (the harness of voice.real.test.ts): a Supervisor forking a
 * real runtime child, a VoiceHost forking the real speech worker (file ingest, the fake STT script) with control's real AUDIO_DIR hand-off,
 * and raw WebSocket players. One accepted voice line must reach `<AUDIO_DIR>/<logIdentity>/<role>/<seg>.wav` with the runtime's seq; the
 * real sweep must be refused by the live worker's store lock, and after the end delete the folder with exactly one audit line.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const WAIT_MS = 60_000;
const DAY_MS = 86_400_000;
const SCENARIO = "friday-escalation";
const VOICE_ROLE = "account_manager";
const ROLES = ["account_manager", "delivery_lead", "tech_lead"];
const RATE = 16_000;

async function until<T>(what: string, fn: () => T | undefined | false): Promise<T> {
  let got: T | undefined;
  await vi.waitFor(() => { const v = fn(); if (!v) throw new Error(`still waiting for ${what}`); got = v; }, { timeout: WAIT_MS, interval: 25 });
  return got as T;
}
function tone(ms: number): Int16Array {
  const out = new Int16Array(Math.round((ms * RATE) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(4600 * Math.sin((2 * Math.PI * 500 * i) / RATE));
  return out;
}
const silence = (ms: number): Int16Array => new Int16Array(Math.round((ms * RATE) / 1000));
const concat = (...p: Int16Array[]): Int16Array => { const o = new Int16Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

class Client {
  readonly msgs: any[] = [];
  private constructor(readonly ws: WebSocket) { ws.on("message", (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch { /* not json */ } }); }
  static open(port: number): Promise<Client> { return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(new Client(w))); w.on("error", rej); }); }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  close(): void { try { this.ws.terminate(); } catch { /* gone */ } }
}

let root = "";
let sup: Supervisor | undefined;
const clients: Client[] = [];
const pids: number[] = [];
const realTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-audio-real-")); });
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await sup?.shutdown().catch(() => undefined);
  sup = undefined;
  await until("every child to be gone", () => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  rmSync(root, { recursive: true, force: true });
});

describe("the audio store through real processes (US-0073, Task 10)", () => {
  it("an accepted voice line is stored with the runtime's seq; the live worker's lock blocks the sweep; after the end the sweep deletes and audits once", async () => {
    const ingest = path.join(root, "ingest");
    mkdirSync(ingest);
    writeFileSync(path.join(ingest, `${VOICE_ROLE}.wav`), encodeWav(concat(silence(200), tone(700), silence(900)), RATE));
    const script = path.join(root, "script.json");
    writeFileSync(script, JSON.stringify({ [VOICE_ROLE]: ["AM-STORED-LINE we ship in May."] }));
    const config: ControlConfig = loadControlConfig({ CONTROL_DATA_DIR: root, LAUNCHER_TOKEN: "t".repeat(40), CONTROL_GRACE_MS: "10000", CONTROL_READY_TIMEOUT_MS: "40000", AUDIO_MIN_FREE_MB: "512" });
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, MODEL_PROVIDER: "mock", VOICE_ENABLED: "1", CONSENT_NOTICE_VERSION: "v3", TURN_END_MS: "300",
      STT_PROVIDER: "fake", STT_FAKE_SCRIPT: script, SPEECH_INGEST: "file", SPEECH_INGEST_DIR: ingest,
    };
    const logs: string[] = [];
    let voice: VoiceHost | undefined;
    const spawnRuntime = forkSpawn();
    const spawnWorker = speechSpawn();
    sup = new Supervisor({
      config, list: new SessionList(config.listFile), scenarios: () => listScenarios(config.scenariosDir), parentEnv, log: (m) => logs.push(m),
      spawn: (o) => { const h = spawnRuntime(o); pids.push((h as unknown as { pid: number }).pid); return h; },
      voice: (deps) => (voice = new VoiceHost({ spawn: (o) => { const h = spawnWorker(o); if (h.pid) pids.push(h.pid); return h; }, config, parentEnv, log: (m) => logs.push(m), setTimer: realTimer, ...deps })),
    });
    const created = await sup.create(SCENARIO);
    const id = created.sessionId;
    await until("the speech worker to start", () => voice?.workerPid(id));
    const codes = new Map(created.codes.map((c) => [c.roleId, c.code]));
    const players: Record<string, Client> = {};
    for (const roleId of ROLES) {
      const c = await Client.open(created.port);
      clients.push(c);
      c.send({ type: "join", sessionId: id, roleId, participantId: `human-${roleId}`, joinCode: codes.get(roleId) });
      await until(`${roleId} to join`, () => { if (c.msgs.some((m) => m.type === "error")) throw new Error(`${roleId} refused`); return c.msgs.some((m) => m.type === "joined"); });
      c.send({ type: "consent", noticeVersion: "v3" });
      players[roleId] = c;
    }
    const fac = sup.facilitator(id)!;
    const f = await Client.open(fac.port);
    clients.push(f);
    f.send({ type: "join_facilitator", sessionId: id, token: fac.token });
    await until("every seat to be ready", () => {
      const r = [...f.msgs].reverse().find((m) => m.type === "roster" && m.audience === "facilitator");
      return r?.entries?.length === ROLES.length && r.entries.every((e: { joined: boolean; consented: boolean }) => e.joined && e.consented);
    });
    f.send({ type: "start" });
    await until("the start", () => f.msgs.some((m) => m.type === "event" && m.event.type === "session.started"));
    players[VOICE_ROLE]!.send({ type: "voice_opt_in", noticeVersion: "v3" });
    await until("the opt-in", () => players[VOICE_ROLE]!.msgs.some((m) => m.type === "voice" && m.state === "voice"));

    const logFile = path.join(config.sessionsDir, `${id}.jsonl`);
    const events = (): any[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const line = await until("the voice line", () => events().find((e) => e.type === "utterance" && e.channel === "voice"));
    expect(line.text).toBe("AM-STORED-LINE we ship in May.");

    // The store: control handed the runtime's log identity to the worker, which wrote the accepted line after the runtime's answer.
    const audio = config.audioDir;
    expect(audio).toBe(path.join(root, "audio"));
    const identity = await until("the session's audio folder", () => readdirSync(audio).find((n) => /^[0-9a-f]{32}$/.test(n)));
    const roleDir = path.join(audio, identity, VOICE_ROLE);
    const indexFile = path.join(roleDir, "index.jsonl");
    await until("the index line", () => existsSync(indexFile) && readFileSync(indexFile, "utf8").includes("\n"));
    const index = readFileSync(indexFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(index).toEqual([expect.objectContaining({ v: 1, kind: "segment", participantId: `human-${VOICE_ROLE}`, status: "transcribed", seq: line.seq })]);
    const wav = path.join(roleDir, `${index[0].segment}.wav`);
    expect(statSync(wav).mode & 0o777).toBe(0o600);
    for (const d of [audio, path.join(audio, identity), roleDir]) expect(statSync(d).mode & 0o777).toBe(0o700);
    const b = readFileSync(wav);
    expect([b.toString("ascii", 0, 4), b.toString("ascii", 8, 12), b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)]).toEqual(["RIFF", "WAVE", 1, 1, 16_000, 16]);
    expect(readdirSync(roleDir).sort()).toEqual([`${index[0].segment}.wav`, "index.jsonl"].sort());

    const sweep = (now: number) => sweepAudio({
      audioDir: audio, retentionDays: 30, now: () => now, audit: new AuditLog({ audioDir: audio, now: () => now }), acquireLock: makeAcquireLock(), log: (m) => logs.push(m),
    });
    // The live worker (another process) holds the store lock: even long past any clock, the sweep skips the folder.
    expect(existsSync(path.join(audio, `${identity}.store.lock`))).toBe(true);
    expect(await sweep(Date.now() + 365 * DAY_MS)).toMatchObject({ deleted: 0, skipped: 1 });
    expect(existsSync(wav)).toBe(true);

    // The end: the worker marks the folder ended after its flush, then releases the lock.
    f.send({ type: "end_now" });
    const marker = path.join(audio, identity, "ended.json");
    await until("the ended marker", () => existsSync(marker));
    const ended = JSON.parse(readFileSync(marker, "utf8"));
    expect(ended).toEqual({ v: 1, endedAtMs: expect.any(Number) });
    await until("the store lock to be released", () => !existsSync(path.join(audio, `${identity}.store.lock`)));

    expect(await sweep(ended.endedAtMs + 30 * DAY_MS - 1)).toMatchObject({ deleted: 0, skipped: 0 });
    const at = ended.endedAtMs + 30 * DAY_MS;
    expect(await sweep(at)).toMatchObject({ deleted: 1, skipped: 0 });
    expect(existsSync(path.join(audio, identity))).toBe(false);
    const audit = readFileSync(path.join(audio, `${identity}.audio-audit.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((e) => e.type === "audio.deleted")).toEqual([{ v: 1, ts: at, type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 1 }]);
    expect(await sweep(at + 1)).toMatchObject({ deleted: 0, skipped: 0 });
    expect(readFileSync(path.join(audio, `${identity}.audio-audit.jsonl`), "utf8").trim().split("\n").filter((l) => l.includes("audio.deleted"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(identity);
    expect(logs.join("\n")).not.toMatch(/AM-STORED|human-/);
  });
});
