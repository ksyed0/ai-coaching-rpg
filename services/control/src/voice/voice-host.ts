import path from "node:path";
import { isSafeId } from "@acr/events";
import { WorkerMessageSchema, type ControlToWorker, type WorkerMessage } from "@acr/speech/protocol";
import type { ControlConfig } from "../config.js";
import type { ChildMessage, ParentMessage } from "../protocol.js";
import type { SetTimer } from "../supervisor.js";
import { buildSpeechEnv } from "./speech-env.js";
import { VoiceTokenRefused, type VoiceTokens } from "./tokens.js";

/** The runtime must answer a voice line within this; otherwise the worker is told `refused: "failed"`. */
export const VOICE_LINE_TIMEOUT_MS = 10_000;
/** At most this many voice lines wait for the runtime per session; a line beyond it is refused at once (the runtime is far behind). */
export const MAX_PENDING_LINES = 256;
/**
 * Owner decision 2026-11-08 (spec section 16, open question 1): an EMPTY segment (noise the gate dropped) gets no speaker notice, only a
 * failed transcription does. One constant, so the decision can be reversed in one line.
 */
export const NOTICE_EMPTY_SEGMENTS = false;

/** A forked speech worker as VoiceHost sees it: raw messages in (validated here), ControlToWorker out. */
export type WorkerHandle = {
  send(m: ControlToWorker): boolean;
  onMessage(fn: (raw: unknown) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
  forceKill(): void;
  disconnect(): void;
  /** For the demo's V-07 and the real-process tests only. */
  readonly pid?: number;
};
export type SpeechSpawnFn = (o: { env: NodeJS.ProcessEnv; logFile: string }) => WorkerHandle;
export type VoiceFromRuntime = Extract<ChildMessage, { type: "voice_seats" | "voice_turn" | "voice_choice" | "voice_line_ack" | "voice_line_refused" }>;
type Seats = Extract<ChildMessage, { type: "voice_seats" }>;

type Worker = { handle: WorkerHandle; ready: boolean; exited: boolean; stopping: boolean };
type Session = {
  worker?: Worker;
  /** A1a: once a worker has stopped unexpectedly the session gets none again (restart with backoff is A1b). */
  workerLost: boolean;
  runtimeUp: boolean;
  ended: boolean;
  /** The latest seats the runtime reported (cleared when that runtime exits). */
  seats?: Seats;
  pending: Map<string, () => void>;
  /** The last `voice_turn` the runtime reported (for the demo's V-07 and tests). */
  turnOpen?: boolean;
};

/**
 * US-0070 (EPIC-0003 voice A1a, AC-0403): one speech worker per running voice session, a child of the control service, supervised here.
 * It relays the worker's lines and speech edges to the session's runtime (`toRuntime`, the parent channel) and the runtime's seat state
 * back to the worker as `voice_state`; it times out a line the runtime never answers. The worker never talks to the runtime.
 *  - `attach` (a runtime said `ready` with `voice: true`): forks the worker if none runs; a runtime restart keeps the worker (C6).
 *  - The seats are sent only once the worker said `worker_ready` (before that it may not listen yet), and then on every change.
 *  - `detach` (the runtime exited): pending lines are answered `failed` and the worker is told nobody records until the next seats.
 *  - A worker exit while the session runs: ONE `worker_down` alert to the facilitator; the session keeps running (people continue by
 *    text) and no worker is started again in A1a (A1b adds restart with bounded backoff).
 *  - `end`: a final `ended` state (the worker flushes), then the worker is stopped after `graceMs` (forced after another); once it has
 *    stopped (or when there was none) the session's entry is removed.
 * Every handler is fire-and-forget and never throws. Logs carry the session id and an error name at most: never a text, a participant
 * id, a segment id or a path.
 */
export class VoiceHost {
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  constructor(private readonly o: {
    spawn: SpeechSpawnFn; config: ControlConfig; parentEnv: NodeJS.ProcessEnv; log: (m: string) => void; setTimer: SetTimer;
    toRuntime: (sessionId: string, m: ParentMessage) => boolean;
    bots?: { voiceTurn(sessionId: string, open: boolean): void };
    /** US-0071 (A1b Task 5): the seat rooms, generations and tokens; absent when control has no LiveKit settings. */
    tokens?: VoiceTokens;
  }) {
    // A generation reaches the worker only for a LiveKit ingest: a file-ingest worker would drop every frame (none of its frames has one).
    this.livekitIngest = o.tokens !== undefined && o.parentEnv.SPEECH_INGEST === "livekit";
  }

  private readonly livekitIngest: boolean;

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) { s = { workerLost: false, runtimeUp: false, ended: false, pending: new Map() }; this.sessions.set(id, s); }
    return s;
  }

  attach(sessionId: string, ready: { voice?: true; roles: string[] }): void {
    if (this.closed) return;
    const s = this.session(sessionId);
    s.runtimeUp = true;
    if (ready.voice === true && !s.ended && this.o.tokens) {
      try {
        this.o.tokens.openSession(sessionId);
        if (s.seats) this.o.tokens.seatsChanged(sessionId, s.seats); // a report that came before the attach
      } catch (err) { this.failed(sessionId, err); }
    }
    if (ready.voice !== true || s.ended || s.workerLost || s.worker) return;
    let handle: WorkerHandle;
    try {
      handle = this.o.spawn({ env: buildSpeechEnv(this.o.parentEnv, ready.roles), logFile: path.join(this.o.config.logDir, `${sessionId}.speech.log`) });
    } catch (err) {
      this.o.log(`session ${sessionId} speech worker could not start (${err instanceof Error ? err.name : "error"})`);
      s.workerLost = true;
      this.alert(sessionId, "worker_down");
      return;
    }
    const w: Worker = { handle, ready: false, exited: false, stopping: false };
    s.worker = w;
    handle.onMessage((raw) => { try { this.fromWorker(sessionId, w, raw); } catch (err) { this.failed(sessionId, err); } });
    handle.onExit(() => { try { this.workerExited(sessionId, w); } catch (err) { this.failed(sessionId, err); } });
    this.o.log(`session ${sessionId} speech worker started`);
  }

  fromRuntime(sessionId: string, m: VoiceFromRuntime): void {
    try {
      // F9b: only a live seats report may create the entry (the first one can come before attach); nothing brings back an ended session.
      if (!this.sessions.has(sessionId) && (m.type !== "voice_seats" || m.ended)) return;
      const s = this.session(sessionId);
      if (m.type === "voice_seats") {
        // US-0071: the tokens see every report first (identity removal, waiting token requests), then the worker gets its state.
        try { this.o.tokens?.seatsChanged(sessionId, m); } catch (err) { this.failed(sessionId, err); }
        s.seats = m;
        this.pushState(sessionId, s);
        return;
      }
      if (m.type === "voice_turn") { s.turnOpen = m.open; this.o.bots?.voiceTurn(sessionId, m.open); return; }
      if (m.type === "voice_choice") return; // A2 writes it to the audio audit log
      const answer = s.pending.get(m.segmentId);
      if (!answer) return; // timed out already, or never asked
      s.pending.delete(m.segmentId);
      answer();
      if (m.type === "voice_line_ack") this.toWorker(s, { type: "voice_line_result", segmentId: m.segmentId, seq: m.seq });
      else this.toWorker(s, { type: "voice_line_result", segmentId: m.segmentId, refused: m.code });
    } catch (err) { this.failed(sessionId, err); }
  }

  /** The session's runtime exited: nobody records until the next runtime reports its seats; lines in flight will never be answered. */
  detach(sessionId: string): void {
    try {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.runtimeUp = false;
      s.turnOpen = false; // a new runtime starts with no voice turn open
      this.failPending(s);
      const paused = s.seats?.paused ?? false;
      delete s.seats;
      this.o.tokens?.runtimeExited(sessionId);
      if (s.worker?.ready && !s.ended) this.toWorker(s, { type: "voice_state", paused, ended: false, holders: [] });
    } catch (err) { this.failed(sessionId, err); }
  }

  end(sessionId: string): void {
    try {
      try { this.o.tokens?.endSession(sessionId); } catch (err) { this.failed(sessionId, err); } // every seat room is deleted
      const s = this.sessions.get(sessionId);
      if (!s || s.ended) return;
      s.ended = true;
      const w = s.worker;
      if (!w || w.exited) { this.drop(sessionId, s); return; } // F9b: nothing to stop: forget the session now
      this.toWorker(s, { type: "voice_state", paused: s.seats?.paused ?? false, ended: true, holders: s.seats?.holders ?? [] });
      w.stopping = true;
      const grace = this.o.config.graceMs;
      this.o.setTimer(() => {
        if (w.exited) return;
        try { w.handle.kill(); } catch { /* already gone */ }
        this.o.setTimer(() => { if (!w.exited) { try { w.handle.forceKill(); } catch { /* already gone */ } } }, grace);
      }, grace);
    } catch (err) { this.failed(sessionId, err); }
  }

  /** Disconnects every worker (they exit on their own), waits up to graceMs, then force-kills what is left. Never alerts. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const live = [...this.sessions.values()].flatMap((s) => (s.worker && !s.worker.exited ? [s.worker] : []));
    for (const w of live) { w.stopping = true; try { w.handle.disconnect(); } catch { /* channel already closed */ } }
    if (live.length === 0) return;
    await new Promise<void>((resolve) => {
      let left = live.length;
      const cancel = this.o.setTimer(resolve, this.o.config.graceMs);
      for (const w of live) w.handle.onExit(() => { if (--left === 0) { cancel(); resolve(); } });
    });
    for (const w of live) if (!w.exited) { try { w.handle.forceKill(); } catch { /* already gone */ } }
  }

  /**
   * US-0071 (A1b Task 5): a microphone-only LiveKit token for the caller's own seat room (POST /sessions/:id/voice-token). Rejects
   * VoiceTokenRefused: `voice_unavailable` without LiveKit, for an unknown, non-voice or ended session.
   */
  voiceToken(sessionId: string, roleId: string, participantId: string): Promise<{ token: string; expiresAt: number }> {
    if (!this.o.tokens || this.closed) return Promise.reject(new VoiceTokenRefused("voice_unavailable"));
    return this.o.tokens.issue(sessionId, roleId, participantId);
  }

  /** US-0071: a code reissue (or removal) succeeded: the seat's LiveKit identity goes at once. Never throws. */
  roleReissued(sessionId: string, roleId: string): void {
    try { this.o.tokens?.roleReissued(sessionId, roleId); } catch (err) { this.failed(sessionId, err); }
  }

  /** Whether the session's runtime last reported an open voice turn (for the demo's V-07 and tests). */
  voiceTurnOpen(sessionId: string): boolean { return this.sessions.get(sessionId)?.turnOpen ?? false; }

  workerPid(sessionId: string): number | undefined {
    const w = this.sessions.get(sessionId)?.worker;
    return w && !w.exited ? w.handle.pid : undefined;
  }

  private fromWorker(sessionId: string, w: Worker, raw: unknown): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.worker !== w) return;
    const parsed = WorkerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const m: WorkerMessage = parsed.data;
    switch (m.type) {
      case "worker_ready":
        w.ready = true;
        if (m.stt === "unavailable") this.alert(sessionId, "stt_unavailable");
        this.pushState(sessionId, s);
        return;
      case "voice_line": {
        const refuse = (): void => this.toWorker(s, { type: "voice_line_result", segmentId: m.segmentId, refused: "failed" });
        if (s.ended || !s.runtimeUp || s.pending.has(m.segmentId) || s.pending.size >= MAX_PENDING_LINES) { refuse(); return; }
        const sent = this.o.toRuntime(sessionId, { type: "voice_line", segmentId: m.segmentId, roleId: m.roleId, participantId: m.participantId, text: m.text });
        if (!sent) { refuse(); return; }
        const cancel = this.o.setTimer(() => { if (s.pending.get(m.segmentId) === cancel) { s.pending.delete(m.segmentId); refuse(); } }, VOICE_LINE_TIMEOUT_MS);
        s.pending.set(m.segmentId, cancel);
        return;
      }
      case "speech_activity":
        if (s.runtimeUp) this.o.toRuntime(sessionId, m.silentMs === undefined ? { type: "speech_activity", roleId: m.roleId, active: m.active } : { type: "speech_activity", roleId: m.roleId, active: m.active, silentMs: m.silentMs });
        return;
      case "segment_failed":
        if (!s.runtimeUp) return;
        if (m.status === "stt_failed" || NOTICE_EMPTY_SEGMENTS) this.o.toRuntime(sessionId, { type: "voice_notice", roleId: m.roleId, participantId: m.participantId, code: m.status });
        if (m.status === "stt_failed") this.alert(sessionId, "stt_failed");
        return;
      case "livekit_token_request": {
        // US-0071 (A1b Task 5): a fresh worker token for that seat's room, every time (never cached). A refusal is logged by name and
        // not answered: the worker's own wait times out. Without LiveKit the request is ignored.
        const tokens = this.o.tokens;
        if (!tokens || s.ended) return;
        const roleId = m.roleId;
        tokens.workerJoin(sessionId, roleId).then(
          (j) => { if (s.worker === w && !w.exited) this.toWorker(s, { type: "livekit_join", roleId, url: j.url, token: j.token, room: j.room }); },
          (err: unknown) => this.o.log(`session ${sessionId} speech room token refused (${errName(err)})`),
        );
        return;
      }
      case "livekit_status":
        this.o.log(`session ${sessionId} speech room ${m.state}`); // a fixed sentence: never a role, a room or an identity
        return;
      // US-0071 (A1b): accepted and ignored until their tasks land (slots: Task 6; health: Task 9).
      case "stt_health":
      case "stt_slot_request":
      case "stt_slot_release":
        return;
    }
  }

  private workerExited(sessionId: string, w: Worker): void {
    w.exited = true;
    const s = this.sessions.get(sessionId);
    if (!s || s.worker !== w) return;
    delete s.worker;
    for (const cancel of s.pending.values()) cancel(); // the worker is gone: nobody to answer
    s.pending.clear();
    if (s.ended) { this.drop(sessionId, s); return; } // F9b: the session is over and its worker has stopped
    if (w.stopping || this.closed) return;
    s.workerLost = true;
    this.o.log(`session ${sessionId} speech worker stopped unexpectedly`);
    this.alert(sessionId, "worker_down");
  }

  /** F9b: forgets an ended session whose worker has stopped (or that never had one). */
  private drop(sessionId: string, s: Session): void {
    for (const cancel of s.pending.values()) cancel();
    if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
  }

  private pushState(sessionId: string, s: Session): void {
    if (!s.worker?.ready || !s.seats || s.ended) return;
    const { paused, ended, holders } = s.seats;
    const tokens = this.o.tokens;
    // US-0071: each holder's seat generation, only for a LiveKit ingest (see the constructor); the worker attributes a frame only to it.
    const withGen = this.livekitIngest && tokens ? holders.map((h) => ({ ...h, generation: tokens.generation(sessionId, h.roleId, h.participantId) })) : holders;
    this.toWorker(s, { type: "voice_state", paused, ended, holders: withGen });
  }

  private failPending(s: Session): void {
    for (const [segmentId, cancel] of [...s.pending]) {
      cancel();
      s.pending.delete(segmentId);
      this.toWorker(s, { type: "voice_line_result", segmentId, refused: "failed" });
    }
  }

  private toWorker(s: Session, m: ControlToWorker): void {
    const w = s.worker;
    if (!w || w.exited) return;
    try { w.handle.send(m); } catch { /* the worker is going away; its exit is handled there */ }
  }

  private alert(sessionId: string, code: "worker_down" | "stt_unavailable" | "stt_failed"): void {
    const s = this.sessions.get(sessionId);
    if (s && !s.runtimeUp) return;
    try { this.o.toRuntime(sessionId, { type: "voice_alert", code }); } catch { /* reported nowhere: the runtime is gone */ }
  }

  private failed(sessionId: string, err: unknown): void {
    this.o.log(`session ${sessionId} voice message failed (${err instanceof Error ? err.name : "error"})`);
  }
}

/** An error's name when it is a plain identifier, else a fixed word: never a message (it could name a room or an identity). */
function errName(err: unknown): string {
  return err instanceof Error && isSafeId(err.name) ? err.name : "Error";
}
