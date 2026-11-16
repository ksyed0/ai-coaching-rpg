import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSpeechToText, MockModelProvider, encodeWav } from "@acr/adapters";
import { loadScenario } from "@acr/script";
import { AiRoleSet } from "../../../../runtime/src/engine/ai-roles.js";
import { FakeClock } from "../../../../runtime/src/engine/clock.js";
import { ConsentStore } from "../../../../runtime/src/engine/consent.js";
import { PlayerCredentials } from "../../../../runtime/src/engine/credentials.js";
import { MemoryEventLog } from "../../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../../runtime/src/engine/session-engine.js";
import type { Seats } from "../../../../runtime/src/engine/seats.js";
import { VoiceChoices, type VoiceFileIO } from "../../../../runtime/src/engine/voice-file.js";
import { SessionHost, VoiceRefusedError } from "../../../../runtime/src/host/session-host.js";
import type { WorkerConfig } from "../../../../speech/src/config.js";
import type { WorkerMessage } from "../../../../speech/src/protocol.js";
import { DEFAULT_SEGMENTER } from "../../../../speech/src/segmenter.js";
import { openStore } from "../../../../speech/src/store/store-setup.js";
import { startWorker } from "../../../../speech/src/worker.js";
import { concat, silence, tone } from "../../../../speech/src/__tests__/signals.js";

/**
 * A3A (Task 8): the facilitator's seat mute end to end, with no fake of the host, the worker or the store. The REAL `SessionHost` (real
 * engine, memory log) decides `recording`; this test plays control exactly as `VoiceHost` does: it forwards `host.voiceSeats()` to the REAL
 * `startWorker` as `voice_state`, relays each `voice_line` to `host.onVoiceUtterance` and answers with `voice_line_result`. The REAL
 * `openStore` writes the audio on a private temp dir. A controllable `pace` plays the file ingest in steps, so the mute and the unmute
 * land between two bursts of the same seat. Claim: while the seat is facilitator-muted the worker ignores it (no voice line, no log
 * utterance, no audio file, no role folder); after the unmute its next burst is written again; another seat is unaffected throughout.
 */
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const MUTED = "tech_lead";
const OTHER = "account_manager";
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
const ID = "0123456789abcdef0123456789abcdef";
const BURST = concat(silence(300), tone(800, -20), silence(900)); // 100 frames of 20 ms
const FRAMES_PER_BURST = 100;

let root = "";
const stops: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-mute-e2e-")); });
afterEach(async () => {
  for (const s of stops.splice(0)) await s().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function rig() {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(5_000);
  const log = new MemoryEventLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace([], PLAYERS);
  const credentials = PlayerCredentials.create({ sessionId: "local", scenarioSha256: "d".repeat(64) });
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  const disk = { record: null as unknown };
  const voiceFile: VoiceFileIO = {
    read: () => ({ choices: disk.record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(disk.record, vbind) }),
    write: (c) => { disk.record = c.toRecord(); },
    remove: () => { disk.record = null; },
  };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles, persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: { enabled: true, turnEndMs: 800 } });
  for (const r of PLAYERS) { host.join(r, `p-${r}`); host.giveConsent(r, `p-${r}`, "v3"); }
  await host.start();
  host.optInVoice(MUTED, `p-${MUTED}`, "v3");
  host.optInVoice(OTHER, `p-${OTHER}`, "v3");

  // The audio store and the file ingest: two bursts for the seat under test, one for the other seat.
  const ingestDir = path.join(root, "ingest");
  const sessionsDir = path.join(root, "sessions");
  const audioDir = path.join(root, "audio");
  mkdirSync(ingestDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(ingestDir, `${MUTED}.wav`), encodeWav(concat(BURST, BURST), 16_000));
  writeFileSync(path.join(ingestDir, `${OTHER}.wav`), encodeWav(BURST, 16_000));
  const sent: WorkerMessage[] = [];
  let worker!: ReturnType<typeof startWorker>;
  const answered: { roleId: string; text: string; outcome: "seq" | string }[] = [];
  const send = (m: WorkerMessage): boolean => {
    sent.push(m);
    if (m.type === "voice_line") {
      host.onVoiceUtterance(m.roleId, m.participantId, m.text).then(
        ({ seq }) => { answered.push({ roleId: m.roleId, text: m.text, outcome: "seq" }); worker.onControl({ type: "voice_line_result", segmentId: m.segmentId, seq }); },
        (err: unknown) => { const code = err instanceof VoiceRefusedError ? err.code : "failed"; answered.push({ roleId: m.roleId, text: m.text, outcome: code }); worker.onControl({ type: "voice_line_result", segmentId: m.segmentId, refused: code as "failed" }); },
      );
    }
    return true;
  };
  const storeCfg = { audioDir, minFreeMb: 512, logIdentity: ID, sessionId: "sess-1", sessionsDir };
  const opened = await openStore({ cfg: storeCfg, now: () => 1_800_000_000_000, send, sleep: async () => {} });
  const cfg: WorkerConfig = { segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "file", dir: ingestDir, roles: [MUTED, OTHER] }, store: storeCfg };

  // The ingest plays one frame time per token, so a test decides where the mute and the unmute fall.
  let tokens = 0;
  const waiting: (() => void)[] = [];
  const pace = async (): Promise<void> => { if (tokens > 0) { tokens--; return; } await new Promise<void>((r) => waiting.push(r)); };
  const advance = (n: number): void => { for (let i = 0; i < n; i++) { const w = waiting.shift(); if (w) w(); else tokens++; } };
  worker = startWorker({
    cfg, send, now: () => Date.now(), stt: new FakeSpeechToText({ script: (_s, n) => ({ text: `line ${n + 1}`, durationMs: 50 }) }), store: opened.store, pace,
  });
  stops.push(() => worker.stop(), async () => advance(10_000), async () => opened.release());
  const toWorker = (): void => { const s = host.voiceSeats(); worker.onControl({ type: "voice_state", paused: s.paused, ended: s.ended, holders: s.holders.map((h) => ({ roleId: h.roleId, participantId: h.participantId, recording: h.recording })) }); };
  const unsubscribe = host.onVoiceSeatsChanged(toWorker);
  stops.push(async () => unsubscribe());
  const settle = () => new Promise<void>((r) => setTimeout(r, 50));
  const roleDir = (r: string) => path.join(audioDir, ID, r);
  const wavs = (r: string): string[] => (existsSync(roleDir(r)) ? readdirSync(roleDir(r)).filter((f) => f.endsWith(".wav")) : []);
  const voiceLinesInLog = async (r: string) => (await log.all()).filter((e) => e.type === "utterance" && (e as { channel?: string }).channel === "voice" && (e as { roleId?: string }).roleId === r);
  return { host, log, sent, answered, toWorker, advance, settle, wavs, roleDir, voiceLinesInLog };
}

describe("facilitator mute, end to end through the real host, worker and audio store (A3A, Task 8)", () => {
  it("a muted seat's speech is ignored with no line, no log entry and no audio file; after the unmute its next burst is written again; another seat is unaffected", async () => {
    const r = await rig();
    await r.host.command({ command: "mute_seat", roleId: MUTED, muted: true }, { by: "Facilitator Fay" });
    await r.host.idle();
    expect(r.host.voiceSeats().holders.find((h) => h.roleId === MUTED)!.recording).toBe(false);
    r.toWorker(); // the first voice_state: the other seat records, so the file starts playing; the muted seat's frames are not allowed

    // First burst of both seats, while the tech lead is muted.
    r.advance(FRAMES_PER_BURST + 5);
    await vi.waitFor(() => { if (!r.answered.some((a) => a.roleId === OTHER)) throw new Error("waiting for the other seat's line"); }, { timeout: 20_000, interval: 10 });
    await r.settle();
    expect(r.answered.filter((a) => a.roleId === OTHER)).toEqual([{ roleId: OTHER, text: expect.any(String), outcome: "seq" }]);
    expect(r.sent.filter((m) => m.type === "voice_line" && m.roleId === MUTED)).toEqual([]); // the worker ignored the muted seat
    expect(r.answered.filter((a) => a.roleId === MUTED)).toEqual([]); // so the runtime was never even asked
    expect(await r.voiceLinesInLog(MUTED)).toEqual([]);
    expect(r.wavs(MUTED)).toEqual([]);
    expect(existsSync(r.roleDir(MUTED))).toBe(false); // not even an empty role folder
    expect(r.wavs(OTHER)).toHaveLength(1); // the same worker and store did write the unmuted seat

    // The unmute: recording is back, voice_state is re-sent, the second burst is heard.
    await r.host.command({ command: "mute_seat", roleId: MUTED, muted: false }, { by: "Facilitator Fay" });
    await r.host.idle();
    expect(r.host.voiceSeats().holders.find((h) => h.roleId === MUTED)!.recording).toBe(true);
    await r.settle(); // the coalesced voice_state reaches the worker through the subscription
    r.advance(10 * FRAMES_PER_BURST);
    await vi.waitFor(() => { if (!r.answered.some((a) => a.roleId === MUTED)) throw new Error("waiting for the unmuted seat's line"); }, { timeout: 20_000, interval: 10 });
    await r.settle();
    expect(r.answered.filter((a) => a.roleId === MUTED)).toEqual([{ roleId: MUTED, text: expect.any(String), outcome: "seq" }]);
    expect(await r.voiceLinesInLog(MUTED)).toHaveLength(1);
    expect(r.wavs(MUTED)).toHaveLength(1); // exactly the second burst: the muted first burst was never stored
    expect(r.wavs(OTHER)).toHaveLength(1);
  });
});
