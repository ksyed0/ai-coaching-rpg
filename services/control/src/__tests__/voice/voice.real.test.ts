import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { speechSpawn } from "../../voice/speech-spawn.js";
import { VoiceHost } from "../../voice/voice-host.js";

/**
 * US-0070 (AC-0398, AC-0403): voice through the REAL processes: a Supervisor forking real runtime children (mock NPC models), a VoiceHost
 * forking the real speech worker (file ingest, the fake STT script), and raw WebSocket players. Private temp dirs, port 0, every wait is a
 * poll on an effect (no elapsed-time assertion), and no child outlives the test. Run in the Linux container before pushing (AGENTS.md 8).
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const WAIT_MS = 60_000;
const SCENARIO = "friday-escalation";
const VOICE_ROLE = "account_manager";
const TEXT_ROLE = "delivery_lead";
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
  readonly raws: string[] = [];
  readonly msgs: any[] = [];
  private constructor(readonly ws: WebSocket) { ws.on("message", (d) => { const raw = d.toString(); this.raws.push(raw); try { this.msgs.push(JSON.parse(raw)); } catch { /* not json */ } }); }
  static open(port: number): Promise<Client> { return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(new Client(w))); w.on("error", rej); }); }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  close(): void { try { this.ws.terminate(); } catch { /* gone */ } }
}

let root = "";
let sup: Supervisor | undefined;
const clients: Client[] = [];
const pids: number[] = [];
const realTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-voice-real-")); });
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await sup?.shutdown().catch(() => undefined);
  sup = undefined;
  await until("every child to be gone", () => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  rmSync(root, { recursive: true, force: true });
});

describe("voice through real processes (US-0070)", () => {
  it("a session with VOICE_ENABLED=1 logs the scripted voice lines under their roles; the text-only seat's file is never transcribed", async () => {
    const ingest = path.join(root, "ingest");
    mkdirSync(ingest);
    // Two turns for the voice seat (a long silence between them), one for the text-only seat at the same time.
    writeFileSync(path.join(ingest, `${VOICE_ROLE}.wav`), encodeWav(concat(silence(200), tone(700), silence(1500), tone(700), silence(900)), RATE));
    writeFileSync(path.join(ingest, `${TEXT_ROLE}.wav`), encodeWav(concat(silence(200), tone(900), silence(900)), RATE));
    const script = path.join(root, "script.json");
    writeFileSync(script, JSON.stringify({ [VOICE_ROLE]: ["AM-VOICE-ONE we ship in May.", "AM-VOICE-TWO and the budget holds."], [TEXT_ROLE]: ["DL-NEVER-TRANSCRIBED"] }));
    const config: ControlConfig = loadControlConfig({ CONTROL_DATA_DIR: root, LAUNCHER_TOKEN: "t".repeat(40), CONTROL_GRACE_MS: "10000", CONTROL_READY_TIMEOUT_MS: "40000" });
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
    // Only the voice seat opts in; the text-only seat's file plays too, and must never reach STT or the log.
    players[VOICE_ROLE]!.send({ type: "voice_opt_in", noticeVersion: "v3" });
    await until("the opt-in", () => players[VOICE_ROLE]!.msgs.some((m) => m.type === "voice" && m.state === "voice"));

    const logFile = path.join(config.sessionsDir, `${id}.jsonl`);
    const events = (): any[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const voiceLines = () => events().filter((e) => e.type === "utterance" && e.channel === "voice");
    await until("both voice lines", () => voiceLines().length >= 2);
    expect(voiceLines().map((e) => [e.roleId, e.text])).toEqual([[VOICE_ROLE, "AM-VOICE-ONE we ship in May."], [VOICE_ROLE, "AM-VOICE-TWO and the budget holds."]]);
    // A typed line from a text-only seat is still recorded as text beside the voice lines.
    players[TEXT_ROLE]!.send({ type: "say", text: "DL-TYPED-LINE" });
    await until("the typed line", () => events().some((e) => e.type === "utterance" && e.roleId === TEXT_ROLE && e.channel === "text" && e.text === "DL-TYPED-LINE"));
    expect(JSON.stringify(events())).not.toContain("DL-NEVER-TRANSCRIBED");
    const calls = readFileSync(`${script}.calls.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.every((c: { roleId: string }) => c.roleId === VOICE_ROLE)).toBe(true);
    // No player frame carries a segment id or a participant id of another seat.
    for (const [roleId, c] of Object.entries(players)) {
      const all = c.raws.join("\n");
      expect(all, roleId).not.toContain("segmentId");
      for (const other of ROLES) if (other !== roleId) expect(all, roleId).not.toContain(`human-${other}`);
    }
    expect(logs.join("\n")).not.toMatch(/AM-VOICE|human-/);
  });
});
