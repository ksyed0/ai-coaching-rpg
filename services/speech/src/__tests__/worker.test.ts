import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSpeechToText, SpeechUnavailableError, encodeWav, type SpeechToText } from "@acr/adapters";
import type { WorkerConfig } from "../config.js";
import type { AudioIngest } from "../ingest/audio-ingest.js";
import type { ControlToWorker, WorkerMessage } from "../protocol.js";
import { DEFAULT_SEGMENTER } from "../segmenter.js";
import { LIVEKIT_JOIN_WAIT_MS, startWorker } from "../worker.js";
import { JOIN_ATTEMPTS, JOIN_RETRY_MS, LiveKitIngest } from "../ingest/livekit-ingest.js";
import { FakeRoomPort, mic, type FakeConn } from "./fake-room.js";
import { concat, silence, tone } from "./signals.js";

let dir: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-worker-"));
  process.env.TMPDIR = dir;
});
afterAll(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(dir, { recursive: true, force: true });
});

const LOUD = -20;
const BURST = concat(silence(300), tone(800, LOUD), silence(900));
const cfgFor = (roles: string[], ingestDir = dir): WorkerConfig => ({
  segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "file", dir: ingestDir, roles },
});
const state = (holders: { roleId: string; participantId: string; recording: boolean }[], o: { paused?: boolean; ended?: boolean } = {}): ControlToWorker =>
  ({ type: "voice_state", paused: o.paused ?? false, ended: o.ended ?? false, holders });

function harness(o: { roles: string[]; stt?: SpeechToText | ((roleId: string) => SpeechToText); ingest?: AudioIngest; ingestDir?: string }) {
  const sent: WorkerMessage[] = [];
  const clock = { t: 9_000_000 };
  const w = startWorker({
    cfg: cfgFor(o.roles, o.ingestDir), send: (m) => { sent.push(m); return true; }, now: () => clock.t,
    stt: o.stt ?? ((roleId) => new FakeSpeechToText({ script: (_s, n) => ({ text: `${roleId} line ${n + 1}`, durationMs: 50 }) })),
    pace: async () => {}, ...(o.ingest ? { ingest: o.ingest } : {}),
  });
  return { w, sent, clock, lines: () => sent.filter((m) => m.type === "voice_line") };
}

describe("startWorker and the US-0071 control messages (A1b Task 2, characterisation; Task 7 answers a livekit_join only when asked)", () => {
  it("an unrequested livekit_join and stt_slot_grant are ignored: no ingest starts, nothing is sent", async () => {
    const ingest = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    const before = h.sent.length;
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "t", room: `v${"0".repeat(32)}` });
    h.w.onControl({ type: "stt_slot_grant", slot: "0123456789abcdef" });
    expect(ingest.start).not.toHaveBeenCalled();
    expect(h.sent.slice(before)).toEqual([]);
    await h.w.stop();
  });
});

describe("startWorker and the global speech-to-text slots (US-0071, A1b Task 6)", () => {
  it("stt_slot_grant is handed to the slot client, and to nothing else", async () => {
    const grants: string[] = [];
    const ingest = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const sent: WorkerMessage[] = [];
    const w = startWorker({
      cfg: cfgFor(["tech_lead"]), send: (m) => { sent.push(m); return true; }, now: () => 1, ingest,
      stt: new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) }), onSlotGrant: (slot) => grants.push(slot),
    });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    const before = sent.length;
    w.onControl({ type: "stt_slot_grant", slot: "0123456789abcdef" });
    expect(grants).toEqual(["0123456789abcdef"]);
    expect(sent.slice(before)).toEqual([]);
    expect(ingest.start).not.toHaveBeenCalled();
    await w.stop();
  });
});

describe("startWorker (US-0070): wiring the pipeline to IPC", () => {
  it("worker_ready is sent after warm-up", async () => {
    let release!: () => void;
    const stt = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) });
    stt.warmUp = () => new Promise<void>((r) => { release = r; });
    const h = harness({ roles: [], stt });
    await new Promise((r) => setImmediate(r));
    expect(h.sent).toEqual([]);
    release();
    await vi.waitFor(() => expect(h.sent).toEqual([{ type: "worker_ready", stt: "ok" }]));
    await h.w.stop();
  });

  it("nothing is ingested before the first voice_state, and a file plays only once a seat records (not in a lobby nobody records in)", async () => {
    const ingest = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl({ type: "voice_line_result", segmentId: "abc", seq: 3 }); // not a state: still nothing
    expect(ingest.start).not.toHaveBeenCalled();
    h.w.onControl(state([]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: false }]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }], { paused: true }));
    expect(ingest.start).not.toHaveBeenCalled();
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    expect(ingest.start).toHaveBeenCalledTimes(1);
    h.w.onControl(state([])); // later states never start a second ingest
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    expect(ingest.start).toHaveBeenCalledTimes(1);
    await h.w.stop();
    expect(ingest.stop).toHaveBeenCalled();
  });

  it("two roles' files give their lines under their own role ids, and the text-only role's file is never transcribed", async () => {
    const sub = await mkdtemp(path.join(dir, "two-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(BURST, BURST), 16000));
    await writeFile(path.join(sub, "pm.wav"), encodeWav(BURST, 16000));
    await writeFile(path.join(sub, "designer.wav"), encodeWav(concat(BURST, BURST), 16000));
    const made = new Map<string, FakeSpeechToText>();
    const stt = (roleId: string) => { let f = made.get(roleId); if (!f) { f = new FakeSpeechToText({ script: (_s, n) => ({ text: `${roleId} line ${n + 1}`, durationMs: 50 }) }); made.set(roleId, f); } return f; };
    const h = harness({ roles: ["tech_lead", "pm", "designer"], stt, ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }, { roleId: "pm", participantId: "p2", recording: true }, { roleId: "designer", participantId: "p3", recording: false }]));
    await vi.waitFor(() => expect(h.lines()).toHaveLength(3));
    expect(h.lines().map((m) => m.type === "voice_line" && [m.roleId, m.participantId, m.text])).toEqual(expect.arrayContaining([
      ["tech_lead", "p1", "tech_lead line 1"], ["tech_lead", "p1", "tech_lead line 2"], ["pm", "p2", "pm line 1"],
    ]));
    expect(made.get("designer")?.calls ?? []).toEqual([]); // AC-0398: the seat that did not opt in is never sent to STT
    expect(h.sent.some((m) => m.type !== "worker_ready" && "roleId" in m && m.roleId === "designer")).toBe(false);
    await h.w.stop();
  });

  it("ended flushes and stops", async () => {
    // An ingest still playing (live audio): every frame is pushed, then it waits for stop, so only the end can close the open segment.
    const pcm = concat(silence(300), tone(900, LOUD)); // still speaking when the end comes
    const ingest: AudioIngest = {
      start: (onFrame) => { for (let i = 0; i + 320 <= pcm.length; i += 320) onFrame("tech_lead", undefined, pcm.slice(i, i + 320)); return new Promise<void>(() => {}); },
      stop: async () => {},
    };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true }];
    h.w.onControl(state(holders));
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "speech_activity", roleId: "tech_lead", active: true }));
    expect(h.lines()).toEqual([]);
    h.w.onControl(state(holders, { ended: true }));
    await h.w.done;
    expect(h.lines()).toEqual([expect.objectContaining({ roleId: "tech_lead", text: "tech_lead line 1" })]);
    expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", active: false });
    const before = h.sent.length;
    h.w.onControl(state(holders)); // nothing records after the end
    await new Promise((r) => setImmediate(r));
    expect(h.sent.length).toBe(before);
  });

  // F2 (review fix wave): a file that ends inside an open segment must not leave the speech edge open for the rest of the session.
  it("the end of a file closes its open segment: the line goes out and the speech edge closes", async () => {
    const sub = await mkdtemp(path.join(dir, "eof-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(silence(300), tone(900, LOUD)), 16000)); // still speaking at the end
    const h = harness({ roles: ["tech_lead"], ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", roleId: "tech_lead", active: false }));
    expect(h.lines()).toEqual([expect.objectContaining({ roleId: "tech_lead", text: "tech_lead line 1" })]);
    expect(h.sent.filter((m) => m.type === "speech_activity").map((m) => (m as { active: boolean }).active)).toEqual([true, false]);
    await h.w.stop();
  });

  it("a file that ends inside a blip too short to keep still closes the speech edge (no line)", async () => {
    const sub = await mkdtemp(path.join(dir, "eofblip-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(silence(300), tone(200, LOUD)), 16000));
    const h = harness({ roles: ["tech_lead"], ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", roleId: "tech_lead", active: false }));
    expect(h.lines()).toEqual([]);
    await h.w.stop();
  });

  it("a failed warm-up reports stt unavailable and segments fail", async () => {
    const sub = await mkdtemp(path.join(dir, "down-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(BURST, 16000));
    const down: SpeechToText = {
      transcribe: async () => { throw new SpeechUnavailableError(); }, health: async () => false, warmUp: async () => { throw new SpeechUnavailableError(); },
    };
    const h = harness({ roles: ["tech_lead"], stt: down, ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toEqual([{ type: "worker_ready", stt: "unavailable" }]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent).toContainEqual(expect.objectContaining({ type: "segment_failed", status: "stt_failed", roleId: "tech_lead" })));
    expect(h.lines()).toEqual([]);
    await h.w.stop();
  });

  it("one shared STT is warmed once; a per-role factory is warmed per distinct instance", async () => {
    const shared = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) });
    const h = harness({ roles: ["a", "b"], stt: shared });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    expect(shared.warmUps).toBe(1);
    await h.w.stop();
  });

  it("an ingest failure is reported by a fixed line and the worker keeps running", async () => {
    const log: string[] = [];
    const sent: WorkerMessage[] = [];
    const w = startWorker({
      cfg: cfgFor(["tech_lead"]), send: (m) => { sent.push(m); return true; }, now: () => 0, log: (m) => { log.push(m); },
      stt: new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) }), ingest: { start: async () => { throw new Error(`secret ${dir}`); }, stop: async () => {} },
    });
    w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(log).toEqual(["speech ingest stopped (Error)"]));
    await w.stop();
  });
});

describe("startWorker with a LiveKit ingest (US-0071, A1b Task 7)", () => {
  const G1 = "11111111";
  const G2 = "22222222";
  const lkCfg: WorkerConfig = { segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "livekit", roles: ["tech_lead", "pm"] } };
  type Holder = { roleId: string; participantId: string; recording: boolean; generation?: string };
  const st = (holders: Holder[], o: { paused?: boolean; ended?: boolean } = {}): ControlToWorker => ({ type: "voice_state", paused: o.paused ?? false, ended: o.ended ?? false, holders });
  type Timer = { fn: () => void; ms: number; cancelled: boolean };

  function lk(o: { ingest?: AudioIngest } = {}) {
    const sent: WorkerMessage[] = [];
    const timers: Timer[] = [];
    const port = new FakeRoomPort();
    const status: string[] = [];
    const clock = { t: 9_000_000 };
    const setTimer = (fn: () => void, ms: number) => { const t: Timer = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
    const w = startWorker({
      cfg: lkCfg, send: (m) => { sent.push(m); return true; }, now: () => clock.t,
      stt: (roleId) => new FakeSpeechToText({ script: (_s, n) => ({ text: `${roleId} line ${n + 1}`, durationMs: 50 }) }),
      setTimer,
      ...(o.ingest ? { ingest: o.ingest } : { makeIngest: ({ join }) => new LiveKitIngest({ room: port, join, onStatus: (s) => status.push(s), setTimer }) }),
    });
    const fire = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
    return { w, sent, timers, port, status, clock, fire };
  }
  /** A stub ingest that records what setAllowed got, and when. */
  function stub() {
    const allowed: Map<string, string>[] = [];
    let sink: ((roleId: string, generation: string | undefined, f: Int16Array) => void) | null = null;
    const ingest: AudioIngest = {
      start: (fn) => { sink = fn; return new Promise<void>(() => {}); }, stop: async () => {},
      setAllowed: (a) => { allowed.push(new Map(a)); },
    };
    return { ingest, allowed, push: (roleId: string, g: string | undefined, f: Int16Array) => sink?.(roleId, g, f) };
  }
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

  it("with livekit ingest the worker asks livekit_token_request for a seat before connecting it, and connects with the answer", async () => {
    const h = lk();
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    await settle();
    expect(h.sent).toContainEqual({ type: "livekit_token_request", roleId: "tech_lead" });
    expect(h.port.opened).toEqual([]);
    h.w.onControl({ type: "livekit_join", roleId: "pm", url: "ws://127.0.0.1:7880", token: "wrong-seat", room: `v${"1".repeat(32)}` }); // nobody asked for pm
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "tok-1", room: `v${"0".repeat(32)}` });
    await settle();
    expect(h.port.opened).toEqual([{ url: "ws://127.0.0.1:7880", token: "tok-1" }]);
    expect(h.status).toEqual(["connected"]);
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "tok-again", room: `v${"0".repeat(32)}` }); // answered already
    await settle();
    expect(h.port.opened).toHaveLength(1);
    await h.w.stop();
  });

  it(`a token request without an answer within LIVEKIT_JOIN_WAIT_MS, ${JOIN_ATTEMPTS} times in a row, fails the join (the ingest reports failed)`, async () => {
    const h = lk();
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    for (let i = 1; i <= JOIN_ATTEMPTS; i++) {
      await settle();
      expect(h.timers.filter((t) => t.ms === LIVEKIT_JOIN_WAIT_MS && !t.cancelled)).toHaveLength(1);
      h.fire(LIVEKIT_JOIN_WAIT_MS);
      await settle();
      if (i < JOIN_ATTEMPTS) { expect(h.status).toEqual([]); h.fire(JOIN_RETRY_MS); }
    }
    expect(h.status).toEqual(["failed"]);
    expect(h.port.opened).toEqual([]);
    await h.w.stop();
  });

  it("livekit_join_refused answers the pending join at once (batch 3 review F1): no failure, the seat is asked for again after the backoff", async () => {
    const h = lk();
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    await settle();
    h.w.onControl({ type: "livekit_join_refused", roleId: "pm" }); // nobody asked for pm: ignored
    h.w.onControl({ type: "livekit_join_refused", roleId: "tech_lead" });
    await settle();
    expect(h.status).toEqual([]);
    expect(h.timers.filter((t) => t.ms === LIVEKIT_JOIN_WAIT_MS && !t.cancelled)).toEqual([]); // the wait is over
    expect(h.sent.filter((m) => m.type === "livekit_token_request")).toHaveLength(1);
    h.fire(JOIN_RETRY_MS);
    await settle();
    expect(h.sent.filter((m) => m.type === "livekit_token_request")).toEqual([
      { type: "livekit_token_request", roleId: "tech_lead" }, { type: "livekit_token_request", roleId: "tech_lead" },
    ]);
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "tok-2", room: `v${"0".repeat(32)}` });
    await settle();
    expect(h.status).toEqual(["connected"]);
    await h.w.stop();
  });

  it("a join timeout while the seat records is retried too (the ingest tells a timeout from a failed open)", async () => {
    const h = lk();
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    await settle();
    h.fire(LIVEKIT_JOIN_WAIT_MS);
    await settle();
    expect(h.status).toEqual([]);
    h.fire(JOIN_RETRY_MS);
    await settle();
    expect(h.sent.filter((m) => m.type === "livekit_token_request")).toHaveLength(2);
    await h.w.stop();
  });

  it("audio from the seat room becomes the holder's line, attributed by generation", async () => {
    const h = lk();
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    await settle();
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "tok-1", room: `v${"0".repeat(32)}` });
    await settle();
    const conn = h.port.conns[0] as FakeConn;
    conn.publish(mic(`tech_lead.g${G1}`, "TR_1"));
    const pcm = concat(silence(300), tone(800, LOUD), silence(900));
    for (let i = 0; i + 480 <= pcm.length; i += 480) { h.clock.t += 30; conn.push("TR_1", pcm.slice(i, i + 480)); await Promise.resolve(); }
    await vi.waitFor(() => expect(h.sent.filter((m) => m.type === "voice_line")).toEqual([expect.objectContaining({ roleId: "tech_lead", participantId: "p1", text: "tech_lead line 1" })]));
    await h.w.stop();
  });

  it("voice_state with generations drives setAllowed in the same synchronous step as the gate update", () => {
    const s = stub();
    const h = lk({ ingest: s.ingest });
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }, { roleId: "pm", participantId: "p2", recording: false, generation: G2 }]));
    expect(s.allowed.at(-1)).toEqual(new Map([["tech_lead", G1]])); // no await between onControl and here
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p3", recording: true, generation: G2 }]));
    expect(s.allowed.at(-1)).toEqual(new Map([["tech_lead", G2]]));
  });

  it("a frame pushed synchronously right after onControl with the old generation is dropped (the gate moved in the same step)", async () => {
    const s = stub();
    const h = lk({ ingest: s.ingest });
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }]));
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p2", recording: true, generation: G2 }]));
    const pcm = concat(silence(300), tone(800, LOUD), silence(900));
    for (let i = 0; i + 320 <= pcm.length; i += 320) s.push("tech_lead", G1, pcm.slice(i, i + 320));
    await settle();
    expect(h.sent.filter((m) => m.type === "voice_line" || m.type === "speech_activity")).toEqual([]);
  });

  it("paused or ended voice_state gives setAllowed an empty map; a holder without a generation is never allowed", () => {
    const s = stub();
    const h = lk({ ingest: s.ingest });
    const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true, generation: G1 }];
    h.w.onControl(st(holders, { paused: true }));
    expect(s.allowed.at(-1)).toEqual(new Map());
    h.w.onControl(st(holders));
    expect(s.allowed.at(-1)).toEqual(new Map([["tech_lead", G1]]));
    h.w.onControl(st([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    expect(s.allowed.at(-1)).toEqual(new Map());
    h.w.onControl(st(holders, { ended: true }));
    expect(s.allowed.at(-1)).toEqual(new Map());
  });
});
