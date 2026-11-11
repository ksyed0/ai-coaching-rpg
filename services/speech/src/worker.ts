import type { SpeechToText } from "@acr/adapters";
import { ActivityReporter } from "./activity.js";
import type { WorkerConfig } from "./config.js";
import type { AudioIngest } from "./ingest/audio-ingest.js";
import { HealthPoller } from "./health.js";
import { FileIngest } from "./ingest/file-ingest.js";
import { LiveKitJoinRefused, LiveKitJoinTimeout, type LiveKitJoinInfo } from "./ingest/livekit-ingest.js";
import { MAX_PENDING_LINES, VOICE_LINE_TIMEOUT_MS, type ControlToWorker, type WorkerMessage } from "./protocol.js";
import { Segmenter } from "./segmenter.js";
import type { AudioStore } from "./store/audio-store.js";
import { STT_DEADLINE_MS, TrackPipeline, newSegmentId, type SegmentAudio } from "./track-pipeline.js";
import { VoiceGate } from "./voice-gate.js";

/** US-0071 (A1b Task 7): how long the worker waits for control's `livekit_join` after a `livekit_token_request`. */
export const LIVEKIT_JOIN_WAIT_MS = 10_000;
/**
 * US-0073 (A2a Task 7b): how long a text segment's audio waits for its `voice_line_result`. A backstop only: control's own
 * VOICE_LINE_TIMEOUT_MS normally answers first (`refused: failed`). Running out writes nothing (a timeout never keeps audio).
 */
export const LINE_RESULT_WAIT_MS = VOICE_LINE_TIMEOUT_MS + 2_000;
/** The store as the worker uses it (injected: main.ts gives the real AudioStore). */
export type WorkerStore = { write: AudioStore["write"]; markEnded(): void; readonly stopped: boolean };
/** Returns a cancel function (the Supervisor's shape). */
export type SetTimer = (fn: () => void, ms: number) => () => void;
const realSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); };

type VoiceStateMessage = Extract<ControlToWorker, { type: "voice_state" }>;
/**
 * US-0071 (A1b Task 7): the seats a LiveKit ingest may listen to, role -> generation: EMPTY while paused or ended, otherwise every
 * holder with `recording: true` AND a generation (a state without generations, i.e. for file ingest, allows nothing to a LiveKit ingest).
 */
export function allowedOf(m: VoiceStateMessage): Map<string, string> {
  const allowed = new Map<string, string>();
  if (m.paused || m.ended) return allowed;
  for (const h of m.holders) if (h.recording && h.generation !== undefined) allowed.set(h.roleId, h.generation);
  return allowed;
}

export type RunningWorker = {
  /** One validated message from control. Never throws. */
  onControl(m: ControlToWorker): void;
  /** Stops the ingest (no flush); resolves once no frame will come. */
  stop(): Promise<void>;
  /** Resolves after the session end was handled (flushed, edges closed) or after `stop`. */
  done: Promise<void>;
};

/**
 * US-0070 (EPIC-0003 voice A1a): the speech worker's wiring, in-process and testable (main.ts only adds the IPC channel).
 *  - Warms speech-to-text up (each distinct instance once, under the limiter's cold deadline) and then sends `worker_ready`; a failed
 *    warm-up reports `stt: "unavailable"` and the worker keeps running (its segments fail as `stt_failed`).
 *  - Starts the ingest only after a `voice_state` (overview C6) in which a seat records and the session is not paused (a file plays from
 *    then on, as live audio would only then be listened to), and builds one TrackPipeline per role on its first frame.
 *  - Every `voice_state` updates the gate; each role that stopped recording has its open segment discarded at once.
 *  - The end of the ingest (a file ran out) flushes every track's open segment and closes its speech edge (F2).
 *  - `ended`: stops the ingest, flushes every track's open segment (audio recorded before the end), delivers what is pending, then applies
 *    the ended state (nothing records after it).
 * Logs fixed sentences and error names only.
 *
 * US-0073 (A2a Task 7b): with a `store`, each delivered segment's audio is handed over before its send: `empty` and `stt_failed` are
 * written at once; a text line's audio waits in memory (at most MAX_PENDING_LINES, the oldest dropped unwritten beyond that) for its
 * `voice_line_result`, whose `seq` or refusal goes to `store.write` (the consent rule there keeps or skips it). No answer within
 * LINE_RESULT_WAIT_MS, a stopped role, the end, `stop` and a stopped store all write nothing.
 *
 * US-0071 (A1b Task 7): every `voice_state` gives the ingest its allowed seats (`allowedOf`) in the SAME synchronous step as the gate
 * update, so no frame can pass between the two; frames carry their seat generation and the pipeline drops any that is not the gate's.
 * A LiveKit ingest is built by `makeIngest` with `join`: a `livekit_token_request` to control, answered by the matching `livekit_join`
 * (or rejected at once by `livekit_join_refused`, or after LIVEKIT_JOIN_WAIT_MS).
 */
export function startWorker(o: {
  cfg: WorkerConfig; send: (m: WorkerMessage) => boolean; now: () => number;
  /** One shared SpeechToText (the limited Whisper client) or one per role (the fake script). */
  stt: SpeechToText | ((roleId: string) => SpeechToText);
  ingest?: AudioIngest; pace?: (ms: number) => Promise<void>; log?: (m: string) => void;
  /** US-0071: builds the LiveKit ingest (main.ts, with the real room); `join` asks control for a fresh token to a seat's room. */
  makeIngest?: (deps: { join: (roleId: string) => Promise<LiveKitJoinInfo> }) => AudioIngest;
  setTimer?: SetTimer;
  /** US-0071 (A1b Task 6): control granted a speech-to-text slot (main.ts hands it to the SlotSpeechToText). */
  onSlotGrant?: (slot: string) => void;
  /** US-0071 (A1b Task 9): poll the shared speech-to-text's health after the warm-up (main.ts: Whisper only; the fake is not polled). */
  healthPoll?: boolean;
  /** US-0073 (A2a Task 7b): the audio store. Without one no audio is held or written (A1 behaviour). */
  store?: WorkerStore;
}): RunningWorker {
  const log = o.log ?? (() => {});
  const send = (m: WorkerMessage): void => { try { o.send(m); } catch { /* a closed channel: the parent is gone */ } };
  const sttFor = typeof o.stt === "function" ? o.stt : (() => o.stt as SpeechToText);
  const gate = new VoiceGate();
  const activity = new ActivityReporter(send, o.now);
  const pipelines = new Map<string, TrackPipeline>();
  const setTimer = o.setTimer ?? realSetTimer;
  /** One pending `livekit_token_request` per role. */
  const joins = new Map<string, { resolve: (j: LiveKitJoinInfo) => void; reject: (e: Error) => void; cancel: () => void }>();
  // Batch 3 review F1: a refusal and a timeout reject with their own types, so the ingest retries them (a failed open stays fatal).
  const join = (roleId: string): Promise<LiveKitJoinInfo> => new Promise((resolve, reject) => {
    if (joins.has(roleId) || ending) { reject(new Error("a token request for this seat is already waiting")); return; }
    const cancel = setTimer(() => { if (joins.get(roleId)?.cancel === cancel) { joins.delete(roleId); reject(new LiveKitJoinTimeout()); } }, LIVEKIT_JOIN_WAIT_MS);
    joins.set(roleId, { resolve, reject, cancel });
    send({ type: "livekit_token_request", roleId });
  });
  const ingest: AudioIngest = o.ingest ?? (o.makeIngest ? o.makeIngest({ join })
    : o.cfg.ingest.kind === "file" ? new FileIngest({ dir: o.cfg.ingest.dir, roles: o.cfg.ingest.roles, frameMs: 20, pace: o.pace ?? (async () => {}) })
    : (() => { throw new Error("a LiveKit ingest needs makeIngest"); })());
  let ingestStarted = false;
  let ending = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  // US-0073 (A2a Task 7b): text segments waiting for the runtime's answer, oldest first (Map insertion order). Only an answer the
  // consent rule keeps reaches the store; a stop of the role, a timeout, the end, `stop` or the cap drop an entry unwritten.
  const store = o.store;
  const pending = new Map<string, { seg: SegmentAudio; cancel: () => void }>();
  let storeClosed = false;
  const dropPending = (segmentId: string): void => {
    const e = pending.get(segmentId);
    if (!e) return;
    e.cancel();
    pending.delete(segmentId);
  };
  const dropAllPending = (): void => { for (const id of [...pending.keys()]) dropPending(id); };
  const dropRoles = (roles: readonly string[]): void => {
    if (roles.length === 0) return;
    const set = new Set(roles);
    for (const [id, e] of [...pending]) if (set.has(e.seg.roleId)) dropPending(id);
  };
  const baseOf = (s: SegmentAudio) => ({ roleId: s.roleId, participantId: s.participantId, segmentId: s.segmentId, startMs: s.startMs, endMs: s.endMs, pcm: s.pcm });
  const onSegmentAudio = (s: SegmentAudio): void => {
    if (!store || storeClosed || store.stopped) return;
    if (s.outcome !== "text") { store.write({ ...baseOf(s), outcome: { kind: "no_text", status: s.outcome } }); return; }
    dropPending(s.segmentId); // never happens (fresh random ids); keeps one timer per entry
    while (pending.size >= MAX_PENDING_LINES) { const oldest = pending.keys().next().value; if (oldest === undefined) break; dropPending(oldest); }
    const entry = { seg: s, cancel: () => {} };
    entry.cancel = setTimer(() => { if (pending.get(s.segmentId) === entry) pending.delete(s.segmentId); }, LINE_RESULT_WAIT_MS);
    pending.set(s.segmentId, entry);
  };
  const onLineResult = (m: Extract<ControlToWorker, { type: "voice_line_result" }>): void => {
    const e = pending.get(m.segmentId);
    if (!e || !store) return; // a late answer (after the wait, a drop or the end), or nobody held it
    dropPending(m.segmentId);
    if (store.stopped) return;
    const base = baseOf(e.seg);
    if (m.seq !== undefined) store.write({ ...base, outcome: { kind: "accepted" }, seq: m.seq, ...(e.seg.raw !== undefined ? { raw: e.seg.raw } : {}) });
    else if (m.refused !== undefined) store.write({ ...base, outcome: { kind: "refused", code: m.refused } }); // decide() keeps or skips
  };
  const closeStore = (): void => { storeClosed = true; dropAllPending(); };

  const pipelineFor = (roleId: string): TrackPipeline => {
    let p = pipelines.get(roleId);
    if (!p) {
      p = new TrackPipeline({
        roleId, segmenter: new Segmenter(o.cfg.segmenter), stt: sttFor(roleId), gate, activity, send, now: o.now, newSegmentId, deadlineMs: STT_DEADLINE_MS,
        ...(store ? { onSegmentAudio } : {}),
      });
      pipelines.set(roleId, p);
    }
    return p;
  };

  const instances = [...new Set(typeof o.stt === "function" ? o.cfg.ingest.roles.map((r) => sttFor(r)) : [o.stt])];
  let health: HealthPoller | undefined;
  // US-0071 (Task 9): the poll starts from this worker's own warm-up result (control has it from worker_ready), so a restarted worker
  // whose warm-up succeeds is healthy without any stt_health.
  const ready = (ok: boolean): void => {
    send({ type: "worker_ready", stt: ok ? "ok" : "unavailable" });
    if (o.healthPoll && typeof o.stt !== "function" && !ending) {
      health = new HealthPoller({ stt: o.stt, setTimer, send, initial: ok });
      health.start();
    }
  };
  void Promise.all(instances.map((s) => s.warmUp())).then(() => ready(true), () => ready(false));

  const startIngest = (): void => {
    ingestStarted = true;
    ingest.start((roleId, generation, frame) => { if (!ending) pipelineFor(roleId).push(frame, generation); })
      // F2: the ingest ran out (the end of a file): every open segment is closed now, so no speech edge stays open for the session.
      .then(() => { if (!ending) return Promise.all([...pipelines.values()].map((p) => p.flush())).then(() => undefined); })
      .catch((err: unknown) => log(`speech ingest stopped (${err instanceof Error ? err.name : "error"})`));
  };

  const end = async (m: Extract<ControlToWorker, { type: "voice_state" }>): Promise<void> => {
    health?.stop();
    try {
      await ingest.stop();
      await Promise.all([...pipelines.values()].map((p) => p.flush()));
    } catch (err) { log(`speech flush failed (${err instanceof Error ? err.name : "error"})`); }
    gate.update(m);
    // US-0073: the ended state: every waiting segment is dropped unwritten, then the session folder is marked ended (once).
    closeStore();
    if (store) { try { store.markEnded(); } catch { /* never throws; reporting only */ } }
    for (const p of pipelines.values()) p.stop();
    resolveDone();
  };

  return {
    onControl(m) {
      try {
        if (m.type === "livekit_join") {
          const j = joins.get(m.roleId);
          if (!j || ending) return; // nobody asked (or asked and gave up): never connect on an unrequested token
          joins.delete(m.roleId);
          j.cancel();
          j.resolve({ url: m.url, token: m.token, room: m.room });
          return;
        }
        if (m.type === "stt_slot_grant") { o.onSlotGrant?.(m.slot); return; }
        if (m.type === "livekit_join_refused") {
          const j = joins.get(m.roleId);
          if (!j) return; // nobody is waiting (answered, timed out, or never asked)
          joins.delete(m.roleId);
          j.cancel();
          j.reject(new LiveKitJoinRefused());
          return;
        }
        if (m.type === "voice_line_result") { onLineResult(m); return; }
        if (m.type !== "voice_state" || ending) return;
        if (m.ended) { ending = true; ingest.setAllowed?.(new Map()); void end(m); return; }
        // US-0071: the gate and the ingest's allowed seats change together, in this one synchronous step (no await in between).
        // US-0073 (Review Focus 1): so does the drop of every segment a stopped role (opt-out, reissue, generation change, pause) still
        // holds, so a later answer finds nothing and no audio of it is ever written.
        const { stopped } = gate.update(m);
        dropRoles(stopped);
        ingest.setAllowed?.(allowedOf(m));
        for (const roleId of stopped) pipelines.get(roleId)?.stop();
        // A file is a stand-in for live audio: it starts playing when a seat first records, so its speech meets a listening pipeline.
        if (!ingestStarted && !m.paused && m.holders.some((h) => h.recording)) startIngest();
      } catch (err) { log(`speech control message failed (${err instanceof Error ? err.name : "error"})`); }
    },
    async stop() {
      ending = true;
      health?.stop();
      closeStore();
      await ingest.stop().catch(() => undefined);
      resolveDone();
    },
    done,
  };
}
