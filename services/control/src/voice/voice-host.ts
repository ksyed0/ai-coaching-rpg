import path from "node:path";
import { isSafeId } from "@acr/events";
import { WorkerMessageSchema, type ControlToWorker, type WorkerMessage } from "@acr/speech/protocol";
import type { ControlConfig } from "../config.js";
import type { ChildMessage, ParentMessage, VoiceAlertCode } from "../protocol.js";
import type { SetTimer } from "../supervisor.js";
import { RESTART_TRIES, RESTART_STABLE_MS, restartDelay } from "./restart.js";
import { buildSpeechEnv } from "./speech-env.js";
import { STT_GLOBAL_IN_FLIGHT, SttSlots, sttLeaseMs } from "./stt-slots.js";
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

/** `stable` cancels the RESTART_STABLE_MS timer armed at `worker_ready` (it resets the session's failure count). */
type Worker = { handle: WorkerHandle; ready: boolean; exited: boolean; stopping: boolean; stable?: () => void };
type Session = {
  worker?: Worker;
  /** US-0071 (A1b Task 8): unexpected worker exits (and failed spawns) in a row; reset after a worker was ready for RESTART_STABLE_MS. */
  failures: number;
  /** US-0071: voice is off for the session after RESTART_TRIES failed restarts in a row: no worker is ever started again. */
  voiceOff: boolean;
  /** US-0071: the player roles of the last attach (a timer respawn uses them). */
  roles: string[];
  /** US-0071: cancels the pending restart timer; absent when none is pending. */
  restart?: () => void;
  /**
   * US-0071 (A1b Task 9): whether the speech-to-text server answers, from the current worker's `worker_ready.stt` and its every
   * `stt_health` (kept across a worker exit, so a recovery after a restart is seen as one); undefined until a worker said ready.
   */
  sttHealthy?: boolean;
  /** US-0071 (Task 9): the last `voice_availability` the runtime received (a change is sent; every runtime ready gets it again). */
  told?: { available: boolean; off: boolean };
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
 *  - US-0071 (A1b Task 8): a worker exit while the session runs (or a spawn that throws) is restarted with a bounded consecutive
 *    backoff (restart.ts), each one announced `worker_restarting`; after RESTART_TRIES failed restarts in a row voice is off for the
 *    session (one `voice_off` alert, tokens refused). The session keeps running throughout (people continue by text).
 *  - US-0071 (A1b Task 6): one speech-to-text budget across every session (SttSlots); a stuck worker loses its slot and is killed.
 *  - US-0071 (A1b Task 9): `voice_availability { available, off }` (worker up, speech-to-text healthy, not off) goes to the runtime on
 *    every change and every runtime ready; `stt_unavailable` / `stt_recovered` alerts on a health change only.
 *  - `end`: a final `ended` state (the worker flushes), THEN the seat rooms are deleted, then the worker is stopped after `graceMs`
 *    (forced after another; its speech-to-text slots go back at its exit, D14); once it has
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
    // US-0071 (A1b Task 6): ONE speech-to-text budget for every session of this service; a lease that runs out kills that worker.
    this.slots = new SttSlots({
      max: STT_GLOBAL_IN_FLIGHT, leaseMs: sttLeaseMs(o.parentEnv), setTimer: o.setTimer, log: o.log,
      onExpired: (owner) => { try { this.leaseExpired(owner); } catch (err) { this.failed(owner, err); } },
    });
  }

  private readonly livekitIngest: boolean;
  private readonly slots: SttSlots;

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) { s = { failures: 0, voiceOff: false, roles: [], runtimeUp: false, ended: false, pending: new Map() }; this.sessions.set(id, s); }
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
    if (ready.voice !== true || s.ended) return;
    s.roles = [...ready.roles];
    // US-0071 (Task 9): every runtime ready is told the current availability first (a new runtime knows nothing of it), before anything
    // else voice can reach it.
    this.tellAvailability(sessionId, s, true);
    // US-0071 (Task 8): the worker re-attaches without the runtime's help: a ready worker gets the current state at every runtime ready.
    if (s.worker) { this.pushState(sessionId, s); return; }
    if (s.voiceOff || s.restart) return; // off for good, or a restart is already waiting for its backoff (it uses these roles)
    this.spawnWorker(sessionId, s);
  }

  /**
   * US-0071 (A1b Task 9, AC-0411, K7): `available` = a worker is up (ready, not exited) AND the speech-to-text server answers AND voice
   * is not off. Sent as `voice_availability { available, off }` on every change (and, `force`, on every runtime ready), separate from
   * the alerts and never rate limited: the runtime applies it before anything else. Not sent to a runtime that is down (the next ready
   * gets it) or after the end.
   */
  private tellAvailability(sessionId: string, s: Session, force = false): void {
    if (s.ended || !s.runtimeUp) return;
    const w = s.worker;
    const available = !!w && w.ready && !w.exited && s.sttHealthy === true && !s.voiceOff;
    const off = s.voiceOff;
    if (!force && s.told?.available === available && s.told.off === off) return;
    let sent = false;
    try { sent = this.o.toRuntime(sessionId, { type: "voice_availability", available, off }); } catch { /* the runtime is going away */ }
    if (sent) s.told = { available, off };
  }

  /** US-0071 (Task 9): a health result of the current worker; the alerts fire on a change only (the runtime rate-limits them too). */
  private sttHealth(sessionId: string, s: Session, healthy: boolean): void {
    const was = s.sttHealthy;
    s.sttHealthy = healthy;
    this.tellAvailability(sessionId, s);
    if (!healthy && was !== false) this.alert(sessionId, "stt_unavailable");
    else if (healthy && was === false) this.alert(sessionId, "stt_recovered");
  }

  /** Forks the session's worker with the last attach's roles; a spawn that throws counts as a failure (US-0071, Task 8). */
  private spawnWorker(sessionId: string, s: Session): void {
    let handle: WorkerHandle;
    try {
      handle = this.o.spawn({ env: buildSpeechEnv(this.o.parentEnv, s.roles), logFile: path.join(this.o.config.logDir, `${sessionId}.speech.log`) });
    } catch (err) {
      this.o.log(`session ${sessionId} speech worker could not start (${err instanceof Error ? err.name : "error"})`);
      this.tellAvailability(sessionId, s);
      this.workerFailed(sessionId, s);
      return;
    }
    const w: Worker = { handle, ready: false, exited: false, stopping: false };
    s.worker = w;
    handle.onMessage((raw) => { try { this.fromWorker(sessionId, w, raw); } catch (err) { this.failed(sessionId, err); } });
    handle.onExit(() => { try { this.workerExited(sessionId, w); } catch (err) { this.failed(sessionId, err); } });
    this.o.log(`session ${sessionId} speech worker started`);
  }

  /**
   * US-0071 (A1b Task 8, AC-0410): the worker stopped unexpectedly (any exit code: 3, a lost LiveKit room, included) or could not be
   * spawned. Up to RESTART_TRIES restarts in a row, each after restartDelay(n), each announced `worker_restarting` (the runtime closes
   * an open voice turn on every one and rate-limits the facilitator alert); when the worker of the last restart fails too, voice is off
   * for the session: ONE `voice_off` alert, every seat's LiveKit identity goes and every later token is refused `voice_off`.
   */
  private workerFailed(sessionId: string, s: Session): void {
    if (s.ended || this.closed || s.voiceOff) return;
    s.failures += 1;
    if (s.failures <= RESTART_TRIES) {
      this.alert(sessionId, "worker_restarting");
      const cancel = this.o.setTimer(() => {
        if (s.restart !== cancel) return;
        delete s.restart;
        if (this.closed || s.ended || s.voiceOff || s.worker || this.sessions.get(sessionId) !== s) return;
        this.spawnWorker(sessionId, s);
      }, restartDelay(s.failures));
      s.restart = cancel;
      return;
    }
    s.voiceOff = true;
    this.o.log(`session ${sessionId} voice is off after repeated speech worker faults`);
    this.tellAvailability(sessionId, s);
    this.alert(sessionId, "voice_off");
    try { this.o.tokens?.voiceOff(sessionId); } catch (err) { this.failed(sessionId, err); }
  }

  /** Cancels a pending restart (end, shutdown). */
  private cancelRestart(s: Session): void {
    const cancel = s.restart;
    delete s.restart;
    cancel?.();
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
      const s = this.sessions.get(sessionId);
      const first = s !== undefined && !s.ended;
      if (first) {
        s.ended = true;
        this.cancelRestart(s); // US-0071: an ended session is never respawned
        this.toWorker(s, { type: "voice_state", paused: s.seats?.paused ?? false, ended: true, holders: s.seats?.holders ?? [] });
      }
      // Review finding (case 8): every seat room is deleted only AFTER the worker was sent `ended` (its final flush): deleting a room
      // kicks the worker out of it, and a lost race between that kick and the IPC message would drop the open segments.
      try { this.o.tokens?.endSession(sessionId); } catch (err) { this.failed(sessionId, err); }
      if (!first) return;
      const w = s.worker;
      if (!w || w.exited) { this.drop(sessionId, s); return; } // F9b: nothing to stop: forget the session now
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
    for (const s of this.sessions.values()) this.cancelRestart(s);
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
        if (w.ready) return; // once per worker
        w.ready = true;
        // US-0071 (Task 8): a worker ready for RESTART_STABLE_MS resets the session's failure count (cancelled at its exit).
        w.stable = this.o.setTimer(() => { if (s.worker === w && !w.exited) s.failures = 0; }, RESTART_STABLE_MS);
        // US-0071 (Task 9): the warm-up result counts as a health result, so a restarted worker that warms up is healthy at once.
        this.sttHealth(sessionId, s, m.stt === "ok");
        this.pushState(sessionId, s);
        return;
      case "voice_line": {
        // R13 and the A1a refusal window (US-0071 Task 9: documented and pinned by tests, not changed): from a runtime's exit until the
        // next runtime's attach (the supervisor reads the player roles first) a line is refused `failed`, with no notice. Nothing is
        // buffered across a restart (it could record past a consent change); a new runtime starts in the lobby or resumed paused, so no
        // seat records in that window.
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
        // US-0071 (A1b Task 5): a fresh worker token for that seat's room, every time (never cached). A refusal (or a minting failure) is
        // logged by name and answered `livekit_join_refused` (batch 3 review F1: the worker retries after a backoff instead of timing out
        // into a restart). Without LiveKit the request is ignored.
        const tokens = this.o.tokens;
        if (!tokens || s.ended) return;
        const roleId = m.roleId;
        const current = (): boolean => s.worker === w && !w.exited;
        tokens.workerJoin(sessionId, roleId).then(
          (j) => { if (current()) this.toWorker(s, { type: "livekit_join", roleId, url: j.url, token: j.token, room: j.room }); },
          (err: unknown) => {
            this.o.log(`session ${sessionId} speech room token refused (${errName(err)})`);
            if (current()) this.toWorker(s, { type: "livekit_join_refused", roleId });
          },
        );
        return;
      }
      case "livekit_status":
        this.o.log(`session ${sessionId} speech room ${m.state}`); // a fixed sentence: never a role, a room or an identity
        return;
      case "stt_slot_request": {
        // US-0071 (A1b Task 6): one global budget. The grant goes only to this worker while it is the session's live one; a worker that
        // has gone meanwhile had its slots released at its exit (releaseAll), so a grant for it never happens.
        const slot = m.slot;
        this.slots.request(sessionId, slot, () => {
          if (s.worker === w && !w.exited) this.toWorker(s, { type: "stt_slot_grant", slot });
          else queueMicrotask(() => this.slots.release(sessionId, slot));
        });
        return;
      }
      case "stt_slot_release":
        this.slots.release(sessionId, m.slot);
        return;
      case "stt_health":
        // US-0071 (A1b Task 9): the worker reports a confirmed change only (two polls in a row, every 5 s); before its ready, nothing.
        if (w.ready) this.sttHealth(sessionId, s, m.ok);
        return;
    }
  }

  private workerExited(sessionId: string, w: Worker): void {
    if (w.exited) return; // one exit per worker
    w.exited = true;
    w.stable?.();
    const s = this.sessions.get(sessionId);
    if (!s || s.worker !== w) return;
    delete s.worker;
    this.slots.releaseAll(sessionId); // US-0071 (Task 6): a dead worker's slots go back at once, its waiters are dropped
    for (const cancel of s.pending.values()) cancel(); // the worker is gone: nobody to answer
    s.pending.clear();
    if (s.ended) { this.drop(sessionId, s); return; } // F9b: the session is over and its worker has stopped
    if (w.stopping || this.closed) return; // a clean stop (the end, control's shutdown) is not a failure
    this.o.log(`session ${sessionId} speech worker stopped unexpectedly`);
    this.tellAvailability(sessionId, s); // no worker: not available until the next one is ready (Task 9)
    this.workerFailed(sessionId, s);
  }

  /** F9b: forgets an ended session whose worker has stopped (or that never had one). */
  private drop(sessionId: string, s: Session): void {
    for (const cancel of s.pending.values()) cancel();
    this.slots.releaseAll(sessionId);
    if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
  }

  /**
   * US-0071 (A1b Task 6): a speech-to-text slot of this session outlived its lease (STT_COLD_TIMEOUT_MS + 5 s: no healthy call takes
   * that long), so its worker is stuck: it is killed (forced after graceMs) and its unexpected exit takes the restart path (Task 8).
   */
  private leaseExpired(sessionId: string): void {
    const w = this.sessions.get(sessionId)?.worker;
    if (!w || w.exited) return;
    try { w.handle.kill(); } catch { /* already gone */ }
    this.o.setTimer(() => { if (!w.exited) { try { w.handle.forceKill(); } catch { /* already gone */ } } }, this.o.config.graceMs);
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

  private alert(sessionId: string, code: Exclude<VoiceAlertCode, "worker_down">): void {
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
