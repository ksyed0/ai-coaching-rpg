import type { FacilitatorScene, PlayerScene, PlayerSnapshot, SessionEvent, SessionState } from "@acr/events";
import { commandForPlayer, endedForPlayer, snapshotForPlayer, startedForPlayer } from "./player-copies.js";
import type { NpcRole, Scenario } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { Clock } from "../engine/clock.js";
import { EngineError, type ResumeInfo, type SessionEngine, type SessionStartExtra } from "../engine/session-engine.js";
import type { VoiceAlertCode, VoiceRefusal } from "./parent-channel.js";
import { NpcAgent, type SilentTurn } from "../agents/npc-agent.js";
import { GameMaster, type GmTraceRecord } from "../agents/game-master.js";
import type { Seats } from "../engine/seats.js";
import { ConsentError } from "../engine/consent.js";
import { DEFAULT_REPLY_TIMEOUT_MS, gmDeadlineMs } from "../agents/timeouts.js";
import { actorLabel, cleanBotAlertMessage, cleanClosingMessage, cleanFacilitatorLabel } from "./display-name.js";
import { ReviewUsageError } from "../review/errors.js";
import { noticeNamesAiPlayers, noticeNamesVoice } from "./limits.js";
import { VoiceChoices, type VoiceFileIO } from "../engine/voice-file.js";
import { buildVoiceSeats, gmUnits, realSetTimer, VOICE_ACTIVITY_STALE_MS, VOICE_ALERT_LEVELS, VOICE_ALERT_SENTENCES, VoiceTurnTracker, type SetTimer, type VoiceNoticeCode, type VoiceSeats, type VoiceState } from "./voice.js";
import type { VoiceConfig } from "./voice-config.js";

/** US-0013: at most this many events are replayed to one rejoining client; a client further behind gets `complete: false` and no events. */
export const MAX_REPLAY_EVENTS = 1000;
/** US-0013: at most this many bytes of replayed events (as JSON) per rejoin, well under the server's 1 MiB per-client send buffer. */
export const MAX_REPLAY_BYTES = 256 * 1024;

/**
 * What a rejoining client missed (US-0013): the events with seq in (afterSeq, toSeq] that this viewer may see, oldest first. toSeq is
 * the session's last event when the replay was taken (the join snapshot's lastSeq). `complete: false` means the range could not be
 * replayed in full (older than the retained window, or over MAX_REPLAY_EVENTS / MAX_REPLAY_BYTES): then `events` is empty, never a
 * partial list with a gap, and the client relies on its join snapshot.
 */
export type Replay = { afterSeq: number; toSeq: number; complete: boolean; events: SessionEvent[] };

export type HostErrorCode = "role_taken" | "unknown_role" | "npc_role" | "not_started" | "seats_not_ready" | "consent_version" | "already_started" | "bad_message" | "consent_required" | "not_joined" | "starting" | "ai_notice" | "voice_off" | "forbidden" | "voice_notice_required" | "failed";

export class HostError extends Error {
  /** `roles`, when given, names the roles the error is about: the message becomes `code: role1,role2`. */
  constructor(readonly code: HostErrorCode, roles?: string[]) { super(roles && roles.length > 0 ? `${code}: ${roles.join(",")}` : code); this.name = "HostError"; }
}

/** US-0070: at most one voice_notice per role and code in this long (host clock), so a noisy track cannot flood its speaker. */
export const NOTICE_MIN_INTERVAL_MS = 10_000;
/** US-0070: at most one voice alert per code in this long (host clock). */
export const ALERT_MIN_INTERVAL_MS = 30_000;
/** US-0070 (F10): at most this many voice alerts wait for the start (one per code, so in practice at most the three codes). */
export const MAX_PENDING_VOICE_ALERTS = 8;
/** The refusals of a voice line its speaker hears about (the others have no such speaker listening: not the holder, no such seat, voice off). */
const SPEAKER_NOTICES: ReadonlySet<VoiceRefusal> = new Set<VoiceRefusal>(["paused", "not_in_scene", "ended", "not_recording"]);

/** US-0070: why the host refused a voice line (one of the parent channel's VOICE_REFUSALS). Its message is the code only. */
export class VoiceRefusedError extends Error {
  constructor(readonly code: VoiceRefusal) { super(code); this.name = "VoiceRefusedError"; }
}

export class SessionHost {
  readonly assignments: Record<string, string> = {};
  readonly engine: SessionEngine;
  private readonly scenario: Scenario;
  private readonly npcs = new Map<string, NpcAgent>();
  private readonly gm: GameMaster;
  private readonly log: (msg: string) => void;
  private started = false;
  private starting: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;
  private tickPending = false;
  private roundQueued = false;
  /** US-0018: the scene whose last player line went unanswered when the server stopped; answered once, on the facilitator's /resume. */
  private pendingAnswer: string | null = null;
  private readonly silences: SilentTurn[] = [];
  private readonly maxSilencesKept: number;
  private readonly silentListeners = new Set<(t: SilentTurn) => void>();
  private readonly fatalListeners = new Set<(reason: string) => void>();
  private fatal: string | null = null;
  /** US-0053: durable credentials and consent (absent for embedders and tests: every credential path is then inactive). */
  readonly seats: Seats | undefined;
  /** US-0053: the seat state changed in memory and is not yet on disk; set before persist and cleared only once it succeeded. */
  private seatsDirty = false;
  /** R14: a session resumed from a log that recorded no consents (started before the gate) is not checked on a rejoin. */
  private consentGrandfathered = false;
  /** US-0054: the time recorded with a consent (the injected clock, so tests and replays never read the wall clock). */
  private readonly clock: Clock;
  /** US-0070: voice input settings (VOICE_ENABLED, TURN_END_MS); off unless the bootstrap accepted VOICE_ENABLED=1. */
  private readonly voice: VoiceConfig;
  /** US-0070: the seats' voice choices (only while voice is enabled and the server keeps seats) and where they are saved. */
  private voiceChoices: VoiceChoices | null = null;
  private voiceIO: VoiceFileIO | null = null;
  /** US-0070: seats whose opt-out could neither be saved nor have the file removed: voice stays off for them until a restart. */
  private readonly voiceBlocked = new Set<string>();
  private readonly voiceSeatsListeners = new Set<(s: VoiceSeats) => void>();
  private readonly voiceChoiceListeners = new Set<(c: { roleId: string; participantId: string; choice: "voice" | "text_only"; at: number }) => void>();
  private voiceSeatsQueued = false;
  /** US-0070 (AC-0400): the one voice-turn timer (null while voice is off); the NPC round runs once per voice turn. */
  private readonly turns: VoiceTurnTracker | null = null;
  /**
   * US-0070 (C3): settles once every voice line received so far is recorded or refused, with the highest seq recorded; a turn's round
   * waits on it, so it never starts before the turn's last line is in the log.
   */
  private voiceChain: Promise<number> = Promise.resolve(0);
  /** US-0070 (F1): the highest voice-line seq a voice turn's round was scheduled for; a turn that recorded nothing newer runs no round. */
  private lastAnsweredVoiceSeq = 0;
  private readonly voiceTurnListeners = new Set<(open: boolean) => void>();
  private readonly voiceNoticeListeners = new Set<(roleId: string, code: VoiceNoticeCode) => void>();
  /** US-0070: when each `role\ncode` notice and each alert code was last sent (host clock), for the rate limits. */
  private readonly noticeSentAt = new Map<string, number>();
  private readonly alertSentAt = new Map<VoiceAlertCode, number>();
  /** F10: alerts raised before the start (a worker lost in the lobby, STT down at warm-up), one per code, latest last; logged at the start. */
  private readonly pendingAlerts = new Set<VoiceAlertCode>();
  /** US-0070 (C7): the last seq before this process knew voice-turn boundaries (a restart): lines up to it count by runs (gmUnits). */
  private voiceKnownFrom = 0;
  /** US-0071 (K5): the seats whose holder muted, in memory only (never written, never audited); cleared when the holder is released. */
  private readonly voiceMuted = new Set<string>();
  /**
   * US-0071 (A1b Task 5, R7): human seats whose last holder gave them up (leave, withdrawal, a reissue or removal) and that nobody has
   * bound since; in memory only. They are left out of `voice_seats.open`, so control removes the old LiveKit identity from the seat's
   * room. A plain socket close does not vacate (the same person may come back).
   */
  private readonly voiceVacated = new Set<string>();
  /** US-0071 (K7): control's last `voice_availability` said voice cannot work (worker or speech-to-text down, or off): nobody records. */
  private voiceUnavailable = false;
  /** US-0071 (K6): the speaking roles last told to the listeners, so a listener hears only a real change. */
  private lastSpeaking: string[] = [];
  private readonly speakingListeners = new Set<() => void>();

  constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock; log?: (msg: string) => void; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; npcMaxTokens?: number; gmMaxTokens?: number; npcTemperature?: number; gmTemperature?: number; /** Game Master call deadline (GM_TIMEOUT_MS; default max(reply timeout, 60 s)), one re-ask after an unusable reply (GM_REASK, default true), how often it judges (GM_EVERY_N_UTTERANCES, default 3) and an optional raw-reply trace. */ gmTimeoutMs?: number; gmReask?: boolean; gmEveryN?: number; gmTrace?: (rec: GmTraceRecord) => void; /** US-0034, GM_AUTO_RELEASE (default off): the Game Master releases a hidden fact itself instead of only suggesting it. */ gmAutoRelease?: boolean; /** US-0019, GM_TRANSCRIPT_WINDOW (default 40): the latest utterances of the scene each Game Master prompt holds. */ gmTranscriptWindow?: number; /** How many silent turns to remember for the demo's report (default 1000; the oldest are dropped). */ maxSilencesKept?: number; /** US-0053: durable credentials and consent; when absent, players join by code or reconnect token only. */ seats?: Seats; /** US-0070: voice input (VOICE_ENABLED); default off. */ voice?: VoiceConfig; /** US-0070: the voice-turn timer (default a real, unref'd setTimeout). */ setTimer?: SetTimer }) {
    this.maxSilencesKept = Math.max(1, opts.maxSilencesKept ?? 1000);
    this.scenario = opts.scenario; this.engine = opts.engine;
    this.log = opts.log ?? (() => {});
    // What each AI character may know about the others: name, title and seniority (what every participant sees), never goals or secrets.
    const peers = Object.values(opts.scenario.roles).filter((r): r is NpcRole => r.type === "npc").map((r) => ({ id: r.id, name: r.name, title: r.title, seniority: r.seniority }));
    for (const role of Object.values(opts.scenario.roles)) {
      if (role.type === "npc") this.npcs.set(role.id, new NpcAgent({ role: role as NpcRole, engine: opts.engine, provider: opts.npcProvider, firstTokenTimeoutMs: opts.firstTokenTimeoutMs, replyTimeoutMs: opts.replyTimeoutMs, maxTokens: opts.npcMaxTokens, temperature: opts.npcTemperature, peers, onSilent: (t) => this.noteSilence(t) }));
    }
    // Fail-stop (US-0018): when the log fails or the lock is lost the engine refuses everything; stop the clock and tell the server.
    opts.engine.onFailure((reason) => this.onEngineFailure(reason));
    this.seats = opts.seats;
    this.clock = opts.clock;
    this.voice = opts.voice ?? { enabled: false };
    if (this.voice.enabled) {
      if (this.seats) this.loadVoiceChoices(this.seats);
      this.turns = new VoiceTurnTracker({
        turnEndMs: this.voice.turnEndMs, setTimer: opts.setTimer ?? realSetTimer, staleMs: VOICE_ACTIVITY_STALE_MS,
        onTurnEnd: () => this.endVoiceTurn(),
        onOpenChange: (open) => { for (const fn of this.voiceTurnListeners) { try { fn(open); } catch (err) { this.safeLog(`voice turn listener: ${errorName(err)}`); } } },
        onActiveChange: () => this.noteSpeaking(),
      });
      // Pause, resume, a restart and the end change what may be recorded: the seats are reported again (coalesced; never throws).
      // Pause, a restart (it comes back paused) and the end also clear the voice turn: no round runs for it (AC-0400).
      opts.engine.subscribe((e) => {
        if ((e.type === "facilitator.command" && e.command === "pause") || e.type === "session.resumed" || e.type === "session.ended") this.turns?.clear();
        if (e.type === "facilitator.command" || e.type === "session.started" || e.type === "session.resumed" || e.type === "session.ended") this.noteVoiceSeats();
      });
    }
    // US-0053: a credential is worth nothing after the session ends, so every one is revoked when the end is recorded.
    if (this.seats) opts.engine.subscribe((e) => { if (e.type === "session.ended") { try { this.endSeats(); } catch (err) { this.report("end of session revoke", err); } } });
    // US-0070 (C7): with voice the Game Master counts closed voice turns, not segments, and judges nothing while a turn is open.
    const turns = this.turns;
    const voiceGm = turns ? { units: (l: { seq: number; channel: string }[]) => gmUnits(l, turns.closedTurnEnds, this.voiceKnownFrom), hold: () => turns.open } : {};
    this.gm = new GameMaster({ ...voiceGm, engine: opts.engine, provider: opts.gmProvider, onError: (err) => this.report("GM", err), maxTokens: opts.gmMaxTokens, temperature: opts.gmTemperature, evaluationTimeoutMs: opts.gmTimeoutMs ?? gmDeadlineMs(opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS), reask: opts.gmReask, everyNUtterances: opts.gmEveryN, trace: opts.gmTrace, autoRelease: opts.gmAutoRelease, transcriptWindow: opts.gmTranscriptWindow });
  }

  private noteSilence(t: SilentTurn): void {
    this.silences.push(t);
    if (this.silences.length > this.maxSilencesKept) this.silences.splice(0, this.silences.length - this.maxSilencesKept);
    for (const fn of this.silentListeners) { try { fn(t); } catch (err) { this.report("silence listener", err); } }
  }

  /** The turns an AI character chose to stay silent (no utterance and no event: kept in memory for the demo's report). */
  silentTurns(): readonly SilentTurn[] { return this.silences; }

  /** Calls `fn` for each silent turn from now on; returns the unsubscribe function. */
  onSilentTurn(fn: (t: SilentTurn) => void): () => void { this.silentListeners.add(fn); return () => { this.silentListeners.delete(fn); }; }

  /** US-0034: whether the Game Master releases a hidden fact itself when it judges it earned (GM_AUTO_RELEASE), instead of only suggesting it. */
  get gmAutoRelease(): boolean { return this.gm.autoRelease; }

  /** US-0070: whether voice input is on for this session (VOICE_ENABLED=1, accepted at bootstrap). */
  get voiceEnabled(): boolean { return this.voice.enabled; }

  /** Why the session stopped for good (the log failed or the lock was lost), or null. */
  get fatalReason(): string | null { return this.fatal; }

  /** Calls `fn` once if the session stops for good (see fatalReason). */
  onFatal(fn: (reason: string) => void): () => void { this.fatalListeners.add(fn); return () => { this.fatalListeners.delete(fn); }; }

  private onEngineFailure(reason: string): void {
    if (this.fatal !== null) return;
    this.fatal = reason;
    this.stopTicker();
    for (const fn of this.fatalListeners) { try { fn(reason); } catch (err) { this.report("fatal listener", err); } }
  }

  private report(what: string, err: unknown): void {
    try { this.log(`${what}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); } catch { /* logging must never throw */ }
  }

  /** Whether the scenario has a player role with this id (own properties only), for the login throttle's scope. */
  hasPlayerRole(roleId: string): boolean {
    return Object.hasOwn(this.scenario.roles, roleId) && this.scenario.roles[roleId]?.type === "player";
  }

  /** The scenario's player roles in its order (never an AI character), for the roster. */
  playerRoleIds(): string[] {
    return Object.keys(this.scenario.roles).filter((r) => this.hasPlayerRole(r));
  }

  /**
   * US-0060: whether a player role is played by an AI. Before the start the seat file decides; from the start on the log's record
   * (the folded `aiRoles`) does, so a changed seat file can never relabel a started session.
   */
  isAiRole(roleId: string): boolean {
    return this.engine.state.status === "idle" ? (this.seats?.aiRoles?.has(roleId) ?? false) : this.engine.state.aiRoles.includes(roleId);
  }

  /** US-0061: whether AI players count toward group scores (before the start the seat file's option, default true). */
  includeInGroup(): boolean {
    return this.seats?.aiRoles?.includeInGroup ?? true;
  }

  /** US-0060: the AI roles in the scenario's player-role order. */
  aiRoleIds(): string[] {
    return this.playerRoleIds().filter((r) => this.isAiRole(r));
  }

  /**
   * `rebound` is true when this join took over the consent a code reissue after the start had left waiting for the next participant
   * (US-0058); the caller that then fails to save the seat calls `undoRebind`.
   */
  join(roleId: string, participantId: string): { brief: string; privateFacts: string[]; rebound: boolean } {
    // Own properties only: `__proto__`, `constructor` or `toString` are not roles.
    const role = Object.hasOwn(this.scenario.roles, roleId) ? this.scenario.roles[roleId] : undefined;
    if (!role) throw new HostError("unknown_role");
    if (role.type !== "player") throw new HostError("npc_role");
    // US-0058: a code reissued after the start left the seat's consent waiting (REBIND_PENDING) with no credential on the role: the
    // next participant to hold the seat inherits it. A credential still on the role means the seat is not free: the check below refuses.
    // Only a STARTED session has a marker worth claiming (a reissue before the start clears consent instead): one found earlier is
    // dropped, so the person must consent. While the start is in flight (`starting`) nothing is claimable either.
    // US-0060: an AI seat has no consent to check or rebind: only a human seat is subject to the consent rules below.
    const ai = this.isAiRole(roleId);
    if (!ai && this.seats && !this.started && !this.startBegun && this.seats.consent.isRebindPending(roleId)) { this.seats.consent.withdraw(roleId); this.seatsDirty = true; }
    const rebinding = !ai && !!this.seats && this.started && this.seats.consent.isRebindPending(roleId) && !this.seats.credentials.has(roleId);
    // US-0054: from the start on, a seat is only for the participant whose consent the start recorded (or who gave it since):
    // a dropped seat cannot be taken by someone else with the code. The same participant still reconnects.
    if (!ai && this.seats && !this.consentGrandfathered && (this.started || this.startBegun) && !rebinding && !this.seats.consent.has(roleId, participantId)) throw new HostError("consent_required");
    if (this.assignments[roleId] && this.assignments[roleId] !== participantId) throw new HostError("role_taken");
    let rebound = false;
    if (rebinding && this.seats!.consent.claimRebind(roleId, participantId, this.clock.now())) {
      rebound = true;
      this.seatsDirty = true; // the next seat write records it (the web join writes the credential straight after)
      void this.noteFacilitator(`consent for ${roleId} rebound after a code reissue`);
    }
    this.assignments[roleId] = participantId;
    this.voiceVacated.delete(roleId);
    this.noteVoiceSeats();
    return { brief: role.brief, privateFacts: role.private_facts, rebound };
  }

  /**
   * US-0058: the caller could not save the seat of a join that claimed a rebind (`rebound`): the consent goes back to waiting for the
   * next participant. Marks the seat state dirty so the next write records it.
   */
  undoRebind(roleId: string): void {
    if (!this.started || !this.seats?.consent.releaseForRebind(roleId)) return;
    this.seatsDirty = true;
    void this.noteFacilitator(`rebind of consent for ${roleId} undone: the seat could not be saved and is waiting again`);
  }

  /** US-0058: true once session.started is recorded (a restored session counts). Only then does a reissue rebind consent instead of clearing it. */
  get hasStarted(): boolean { return this.started; }
  /** US-0058: the start is in flight (consents are being frozen into session.started); a reissue is refused meanwhile. */
  get isStarting(): boolean { return !this.started && this.startBegun; }
  /** The start is in flight, or was interrupted after session.started and awaits a retry (BUG-0015): the seats and consents stay frozen as recorded. */
  private get startBegun(): boolean { return this.starting !== null || this.engine.startIncomplete; }

  /** A facilitator-only info alert from synchronous code: never awaited, never throws; a failure goes to the log callback. */
  noteFacilitator(message: string): Promise<void> {
    // Before the start the log must stay empty (engine.start refuses a log with events): no path may append an alert then.
    if (!this.started) return Promise.resolve();
    return this.engine.alert(message, "info").then(() => undefined, (err) => this.report("facilitator alert", err));
  }

  /**
   * US-0060: a live AI player's alert for the facilitator (facilitator-only, level warning). Never throws and appends nothing before the
   * start, after the end, or for a role that is no AI player. The message is flattened to one line (escape sequences and hidden,
   * bidirectional and control characters stripped, whitespace collapsed) and cut to 200 code points; one empty after cleaning is dropped.
   */
  async botAlert(roleId: string, message: string): Promise<void> {
    try {
      if (!this.started || this.engine.state.status === "ended" || !this.isAiRole(roleId)) return;
      const text = cleanBotAlertMessage(message);
      if (text === undefined) return;
      await this.engine.alert(`AI player for ${roleId}: ${text}`, "warning");
    } catch (err) { this.report("bot alert", err); }
  }

  /** Whether the seat's consent stands: given by this participant, or not asked for (a session resumed from a log older than the gate). */
  consentGiven(roleId: string, participantId: string): boolean {
    return this.consentGrandfathered || (this.seats?.consent.has(roleId, participantId) ?? false);
  }

  /** Frees a role, but only for the participant who holds it. */
  release(roleId: string, participantId: string): void {
    // US-0071: a mute belongs to the holder's connection: the next holder (or the same one back) starts unmuted.
    if (this.assignments[roleId] === participantId) { delete this.assignments[roleId]; this.voiceMuted.delete(roleId); this.noteVoiceSeats(); }
  }

  /**
   * US-0053: the holder gives up the seat for good: its credential is revoked, its consent withdrawn, the role released and the seat
   * state persisted. Anyone but the current holder changes nothing. A failed write throws; a retry (even once the role is released)
   * writes again, so a leave never reports success while the revoked credential is still on disk.
   */
  leave(roleId: string, participantId: string): void {
    this.refuseOnceStarting();
    if (Object.hasOwn(this.assignments, roleId) && this.assignments[roleId] === participantId) {
      if (this.seats) this.seatsDirty = true;
      this.seats?.credentials.revoke(roleId);
      this.seats?.consent.withdraw(roleId);
      this.voiceVacated.add(roleId);
      this.release(roleId, participantId);
    }
    this.flushSeats();
  }

  /**
   * US-0054: the holder of the role agrees to the consent notice of `noticeVersion`, recorded with the host clock and persisted.
   * Only the participant who holds the role may give it (anyone else: not_joined). Another version is refused as
   * consent_version; input the store refuses as bad_message. A failed write takes the consent back and throws, so neither the gate
   * nor session.started counts a consent that is not on disk.
   */
  giveConsent(roleId: string, participantId: string, noticeVersion: string): void {
    this.refuseOnceStarting();
    if (!this.holds(roleId, participantId)) throw new HostError("not_joined");
    if (!this.seats) return;
    try {
      this.seats.consent.give(roleId, participantId, noticeVersion, this.clock.now());
    } catch (err) {
      if (err instanceof ConsentError) throw new HostError(err.code === "version_mismatch" ? "consent_version" : "bad_message");
      throw err;
    }
    this.seatsDirty = true;
    try {
      this.flushSeats();
    } catch (err) {
      // Left marked dirty: the next write records the state without it, so the file never keeps a consent memory does not have.
      this.seats.consent.withdraw(roleId);
      throw err;
    }
  }

  /**
   * US-0054: the holder takes their consent back. Without consent the seat cannot take part, so, like a leave, the credential is
   * revoked and the role released; then the seat state is persisted. A failed write throws; a retry by the same caller (the role is
   * released by then) writes again. Anyone else, with nothing waiting to be written, gets not_joined.
   */
  withdrawConsent(roleId: string, participantId: string): void {
    this.refuseOnceStarting();
    if (this.holds(roleId, participantId)) {
      if (this.seats) this.seatsDirty = true;
      this.seats?.consent.withdraw(roleId);
      this.seats?.credentials.revoke(roleId);
      this.voiceVacated.add(roleId);
      this.release(roleId, participantId);
    } else if (!this.seatsDirty) throw new HostError("not_joined");
    this.flushSeats();
  }

  /** US-0070: the seat's holder, or undefined (own properties only). */
  private holderOf(roleId: string): string | undefined {
    return Object.hasOwn(this.assignments, roleId) ? this.assignments[roleId] : undefined;
  }

  /** US-0070: reads the voice record once, at construction. A record that cannot be used is reported by a fixed sentence and removed. */
  private loadVoiceChoices(seats: Seats): void {
    const bind = { sessionId: "memory", logIdentity: seats.credentials.logIdentity };
    const memory: VoiceFileIO = { read: () => ({ choices: VoiceChoices.empty(bind) }), write: () => {}, remove: () => {} };
    this.voiceIO = seats.voiceFile ?? memory;
    try {
      const r = this.voiceIO.read();
      this.voiceChoices = r.choices;
      if (r.problem) {
        this.safeLog(r.problem === "other_log"
          ? "the voice choices on file belong to another session log: they are ignored and removed (every seat starts with no voice choice)"
          : "the voice choices on file could not be read: they are ignored and removed (every seat starts with no voice choice)");
        try { this.voiceIO.remove(); } catch (err) { this.safeLog(`removing the unusable voice choices: ${errorName(err)}`); }
      }
    } catch (err) {
      // Fail closed: no choice is known, so no seat records until its holder opts in again.
      this.safeLog(`reading the voice choices: ${errorName(err)}`);
      this.voiceChoices = VoiceChoices.empty(bind);
    }
  }

  /** The log callback with a fixed sentence (never a path, a value or an Error message). Never throws. */
  private safeLog(line: string): void { try { this.log(line); } catch { /* logging must never throw */ } }

  /**
   * US-0070: the seat's voice state. `off`: voice is disabled, the role is not a human player role, or its opt-out could not be saved;
   * `none`: no choice yet; `voice` / `text_only`: the current holder's own choice. A choice made by anyone else counts as `text_only`:
   * it is never inherited across a reissue, a rebind or a restart.
   */
  voiceStateOf(roleId: string): VoiceState {
    if (!this.voice.enabled || !this.hasPlayerRole(roleId) || this.isAiRole(roleId) || this.voiceBlocked.has(roleId)) return "off";
    return this.voiceChoices?.choiceFor(roleId, this.holderOf(roleId)) ?? "none";
  }

  /**
   * US-0070: the holder chooses to take part with voice. Refusals, in order: voice_off (disabled, or pinned off after a failed opt-out),
   * forbidden (an AI seat), not_joined (not the holder), consent_version (not the server's notice), voice_notice_required (this
   * participant's own consent is missing or to a notice that does not describe voice: such a seat stays text only for the session, C10).
   * The choice is written before it counts: a failed write takes it back and throws HostError("failed") (fail closed, not recording; the
   * error is logged by name only, F8).
   */
  optInVoice(roleId: string, participantId: string, noticeVersion: string): void {
    if (!this.voice.enabled || this.voiceBlocked.has(roleId)) throw new HostError("voice_off");
    if (this.isAiRole(roleId)) throw new HostError("forbidden");
    if (!this.holds(roleId, participantId) || !this.hasPlayerRole(roleId)) throw new HostError("not_joined");
    const seats = this.seats;
    if (seats && noticeVersion !== seats.consent.notice.version) throw new HostError("consent_version");
    const consent = seats?.consent.entryOf(roleId);
    if (!seats || !consent || consent.participantId !== participantId || !noticeNamesVoice(consent.noticeVersion)) throw new HostError("voice_notice_required");
    const choices = this.voiceChoices!;
    const before = choices.entry(roleId);
    const at = this.clock.now();
    choices.set(roleId, { participantId, choice: "voice", noticeVersion, at });
    try { this.voiceIO!.write(choices); }
    catch (err) {
      if (before) choices.set(roleId, before); else choices.remove(roleId);
      // F8: a raw fs error can quote the data directory: the log gets its name only and the player a fixed code.
      this.safeLog(`saving a voice opt-in: ${errorName(err)}`);
      throw new HostError("failed");
    }
    this.noteVoiceSeats();
    this.emitVoiceChoice({ roleId, participantId, choice: "voice", at });
  }

  /**
   * US-0070: the holder chooses to take part by text only. Takes effect in memory FIRST (recording stops at once), then is written. A
   * failed write removes the file instead; if that fails too the seat is pinned off for this process and the facilitator is alerted.
   * Never throws for a failed save: recording has stopped either way. Refusals: voice_off, forbidden, not_joined.
   */
  optOutVoice(roleId: string, participantId: string): void {
    if (!this.voice.enabled) throw new HostError("voice_off");
    if (this.isAiRole(roleId)) throw new HostError("forbidden");
    if (!this.holds(roleId, participantId) || !this.hasPlayerRole(roleId)) throw new HostError("not_joined");
    const choices = this.voiceChoices;
    if (!choices || this.voiceBlocked.has(roleId)) { this.noteVoiceSeats(); return; } // nothing can record for this seat anyway
    const at = this.clock.now();
    choices.set(roleId, { participantId, choice: "text_only", noticeVersion: choices.entry(roleId)?.noticeVersion ?? this.seats!.consent.notice.version, at });
    this.noteVoiceSeats();
    try { this.voiceIO!.write(choices); }
    catch (err) {
      this.safeLog(`saving a voice opt-out: ${errorName(err)}`);
      try { this.voiceIO!.remove(); }
      catch (err2) {
        this.safeLog(`removing the voice choices after a failed opt-out: ${errorName(err2)}`);
        this.voiceBlocked.add(roleId);
        this.noteVoiceSeats();
        this.voiceWarning(`voice choice could not be saved; voice is off for ${roleId} until the session restarts`);
      }
      return;
    }
    this.emitVoiceChoice({ roleId, participantId, choice: "text_only", at });
  }

  /** US-0070: a reissue gives the seat to someone new: the role's voice entry is deleted (a failed write is reported by name only). Never throws. */
  forgetVoice(roleId: string): void {
    this.voiceMuted.delete(roleId);
    this.voiceVacated.add(roleId); // US-0071: the seat goes to someone new: control removes the old LiveKit identity
    const choices = this.voiceChoices;
    if (!this.voice.enabled || !choices) return;
    if (choices.remove(roleId)) {
      try { this.voiceIO!.write(choices); } catch (err) { this.safeLog(`forgetting the voice choice of a reissued seat: ${errorName(err)}`); }
    }
    this.noteVoiceSeats();
  }

  /**
   * US-0071 (K5): the holder mutes or unmutes. In memory only: never written, never audited, cleared when the holder is released.
   * Muted, the seat does not record (`recording` false at once) and the runtime refuses its lines. Refusals, in order: voice_off
   * (disabled), forbidden (an AI seat), not_joined (not the holder of a human player role). F5 decision: accepted in EVERY state of a
   * human seat (`none`, `text_only`, and `off` after a failed opt-out), never refused: a mute can only stop recording, so refusing it
   * would fail open (a page that mutes before choosing voice would be recorded on its opt-in); the `voice` answer reports the real state.
   */
  muteVoice(roleId: string, participantId: string, muted: boolean): void {
    if (!this.voice.enabled) throw new HostError("voice_off");
    if (this.isAiRole(roleId)) throw new HostError("forbidden");
    if (!this.holds(roleId, participantId) || !this.hasPlayerRole(roleId)) throw new HostError("not_joined");
    if (muted) this.voiceMuted.add(roleId); else this.voiceMuted.delete(roleId);
    this.noteVoiceSeats();
  }

  /** US-0071: whether the seat's holder has muted. */
  voiceMutedOf(roleId: string): boolean { return this.voiceMuted.has(roleId); }

  /**
   * US-0071 (K7): control's view of whether voice can work for this session. Applied FIRST, with no rate limit and also before the
   * start: unavailable (`!available || off`) makes every seat's `recording` false. On the change to unavailable every holder whose
   * state is `voice` gets one `voice_unavailable` notice, and on the change back one `voice_available` (F4; neither held back by the
   * per-role notice limit, which only a real transition bypasses); on any change the seats are reported again. Never throws.
   */
  voiceAvailability(available: boolean, off: boolean): void {
    const next = !available || off;
    const was = this.voiceUnavailable;
    this.voiceUnavailable = next;
    if (!this.voice.enabled || next === was) return;
    try {
      this.noteVoiceSeats();
      const code: VoiceNoticeCode = next ? "voice_unavailable" : "voice_available";
      for (const roleId of this.playerRoleIds()) { const p = this.holderOf(roleId); if (p !== undefined) this.noteVoiceTransition(roleId, p, code); }
    } catch (err) { this.safeLog(`voice availability: ${errorName(err)}`); }
  }

  /**
   * US-0071 (K7): a holder bound the seat (a join or a reconnect, called by the server after `joined`) or opted in (F3, called after the
   * `voice` answer): while voice is unavailable, a holder whose state is `voice` is told once. Never throws.
   */
  noteVoiceBound(roleId: string, participantId: string): void {
    if (!this.voiceUnavailable) return;
    try { this.noteVoiceTransition(roleId, participantId, "voice_unavailable"); } catch (err) { this.safeLog(`voice availability: ${errorName(err)}`); }
  }

  /**
   * The `voice_unavailable` or `voice_available` notice to the holder of a human voice seat, past the per-role limit (it is sent only on
   * a real transition, a bind or an opt-in).
   */
  private noteVoiceTransition(roleId: string, participantId: string, code: "voice_unavailable" | "voice_available"): void {
    if (!this.voice.enabled || !this.hasPlayerRole(roleId) || this.isAiRole(roleId) || !this.holds(roleId, participantId) || this.voiceStateOf(roleId) !== "voice") return;
    this.emitVoiceNotice(roleId, code);
  }

  /**
   * US-0071 (K6): the roles speaking now (their last edge was active) that are recording holders. Empty after a pause, the end, a
   * release, a mute, unavailability or the stale backstop.
   */
  speakingRoles(): ReadonlySet<string> {
    return new Set((this.turns?.activeRoles() ?? []).filter((r) => this.isRecordingHolder(r)));
  }

  /** US-0071 (K6): `fn` is called whenever the set of speaking roles changes (for the facilitator's roster only). */
  onSpeakingChanged(fn: () => void): () => void { this.speakingListeners.add(fn); return () => { this.speakingListeners.delete(fn); }; }

  private noteSpeaking(): void {
    let now: string[];
    try { now = [...this.speakingRoles()].sort(); } catch (err) { this.safeLog(`speaking: ${errorName(err)}`); return; }
    if (now.length === this.lastSpeaking.length && now.every((r, i) => r === this.lastSpeaking[i])) return;
    this.lastSpeaking = now;
    for (const fn of this.speakingListeners) { try { fn(); } catch (err) { this.safeLog(`speaking listener: ${errorName(err)}`); } }
  }

  /** US-0070: what the speech worker may record (see buildVoiceSeats): every human holder, in player order, with `recording`. */
  voiceSeats(): VoiceSeats {
    return buildVoiceSeats({
      playerRoles: this.playerRoleIds(), holderOf: (r) => this.holderOf(r), isAi: (r) => this.isAiRole(r), stateOf: (r) => this.voiceStateOf(r),
      paused: this.engine.state.paused, ended: this.engine.state.status === "ended",
      started: this.started, isMuted: (r) => this.voiceMuted.has(r), unavailable: this.voiceUnavailable, isVacated: (r) => this.voiceVacated.has(r),
    });
  }

  /** US-0070: `fn` gets the voice seats after a change of a holder, a choice, pause, resume or the end; coalesced to one call per turn of the event loop. */
  onVoiceSeatsChanged(fn: (s: VoiceSeats) => void): () => void { this.voiceSeatsListeners.add(fn); return () => { this.voiceSeatsListeners.delete(fn); }; }

  /** US-0070: `fn` gets every voice choice that was saved (for the control service's audit log, A2). */
  onVoiceChoice(fn: (c: { roleId: string; participantId: string; choice: "voice" | "text_only"; at: number }) => void): () => void { this.voiceChoiceListeners.add(fn); return () => { this.voiceChoiceListeners.delete(fn); }; }

  private emitVoiceChoice(c: { roleId: string; participantId: string; choice: "voice" | "text_only"; at: number }): void {
    for (const fn of this.voiceChoiceListeners) { try { fn(c); } catch (err) { this.safeLog(`voice choice listener: ${errorName(err)}`); } }
  }

  /** Schedules one voice-seats notification for this turn of the event loop. Never throws (it runs inside engine subscribers). */
  private noteVoiceSeats(): void {
    if (!this.voice.enabled) return;
    // A track that may no longer record stops holding the voice turn open at once (an opt-out, a lost or reissued seat).
    if (this.turns) for (const r of this.turns.activeRoles()) { try { if (!this.isRecordingHolder(r)) this.turns.forget(r); } catch (err) { this.safeLog(`voice turn: ${errorName(err)}`); } }
    if (this.voiceSeatsListeners.size === 0 || this.voiceSeatsQueued) return;
    this.voiceSeatsQueued = true;
    queueMicrotask(() => {
      this.voiceSeatsQueued = false;
      let seats: VoiceSeats;
      try { seats = this.voiceSeats(); } catch (err) { this.safeLog(`voice seats: ${errorName(err)}`); return; }
      for (const fn of this.voiceSeatsListeners) { try { fn(seats); } catch (err) { this.safeLog(`voice seats listener: ${errorName(err)}`); } }
    });
  }

  /** US-0070: a facilitator-only warning about voice (a fixed sentence); before the start or after the end it goes to the log only. */
  private voiceWarning(message: string): void {
    if (!this.started || this.engine.state.status === "ended") { this.safeLog(message); return; }
    this.engine.alert(message, "warning").then(undefined, (err) => this.safeLog(`voice alert: ${errorName(err)}`));
  }

  private holds(roleId: string, participantId: string): boolean {
    return Object.hasOwn(this.assignments, roleId) && this.assignments[roleId] === participantId;
  }

  /** US-0054: the consents and seats go into session.started, so they are frozen from the moment the start begins. */
  private refuseOnceStarting(): void {
    if (this.started || this.startBegun) throw new HostError("already_started");
  }

  /**
   * US-0053: revokes every credential, latches the registry so none is issued again, and persists. Idempotent: a later call writes
   * only when an earlier write failed. A failed write throws.
   */
  endSeats(): void {
    if (!this.seats) return;
    if (!this.seats.credentials.ended) this.seatsDirty = true;
    if (this.seats.credentials.end().length > 0) this.seatsDirty = true;
    this.flushSeats();
  }

  /** Writes the seat state when memory is ahead of the file; throws (leaving it marked) when the write fails. */
  private flushSeats(): void {
    if (!this.seats || !this.seatsDirty) return;
    this.seats.persist();
    this.seatsDirty = false;
  }

  /**
   * US-0018: adopts a session the engine restored from its log (call before the server accepts connections). Role claims start empty,
   * as after any disconnect; the Game Master continues from the log; one unanswered player line is answered on the facilitator's /resume.
   */
  resumeFrom(info: ResumeInfo): void {
    this.started = true;
    if (this.seats) this.adoptStartedConsents(info);
    const scene = info.sceneId;
    // US-0070 (C7): no voice-turn boundary of the lines before the restart is known: they count by runs, also for the restore count.
    this.voiceKnownFrom = this.engine.state.lastSeq;
    const before = info.lastGmSeq === null ? [] : this.engine.state.transcript.filter((u) => u.sceneId === scene && u.seq < info.lastGmSeq!);
    const evaluated = this.turns ? gmUnits(before, this.turns.closedTurnEnds, this.voiceKnownFrom) : before.length;
    this.gm.restore(scene, evaluated);
    this.pendingAnswer = info.pendingLine ? scene : null;
  }

  /**
   * R14: a resumed session counts as started, so every rejoin needs the consent the start recorded. When the consent file is lost
   * (or lacks a role) the log's session.started is the record: seed the missing entries from it (store.adopt: shape checks, and no
   * version comparison, so a newer notice does not lock the participants out). A log with no consents field predates the gate: skip the check.
   */
  private adoptStartedConsents(info: ResumeInfo): void {
    const seats = this.seats!;
    if (!info.startedConsents) { this.consentGrandfathered = true; return; }
    for (const [roleId, c] of Object.entries(info.startedConsents)) {
      if (seats.consent.hasEntry(roleId)) continue;
      try { seats.consent.adopt(roleId, c.participantId, c.noticeVersion, c.at); this.seatsDirty = true; } catch (err) { this.report(`consent of ${roleId} from the log`, err); }
    }
    // The file is a cache of the log's record; write the seed when it can be (a failure is reported and retried by the next seat write).
    try { this.flushSeats(); } catch (err) { this.report("writing the consents seeded from the log", err); }
  }

  /** The scene whose unanswered player line waits for /resume (null when none). */
  get pendingAnswerScene(): string | null { return this.pendingAnswer; }

  /** `started` is set only after engine.start succeeds, so a failed start can be retried: the engine finishes an interrupted opening in place (BUG-0015). */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting === null) {
      // US-0054: the gate. Every start (the `start` message and the auto-start of a facilitator command) comes through here.
      // BUG-0015: not for the retry of a start interrupted after session.started: the log already records who started, and a
      // seat that changed since must not stop the opening from finishing.
      const extra = this.engine.startIncomplete ? undefined : this.startGate();
      // A copy: the gate checked these seats, so a release while the engine waits for its mutex must not change what is recorded.
      this.starting = this.engine.start({ ...this.assignments }, extra)
        // US-0071 (R8): recording needs the start, which counts only from here: the seats are reported again.
        .then(() => { this.started = true; this.noteVoiceSeats(); this.flushPendingAlerts(); })
        .finally(() => { this.starting = null; });
    }
    await this.starting;
  }

  /**
   * US-0054: with seats, every player role must be held and its holder must have consented; else seats_not_ready names the roles.
   * Returns what session.started records of the seats. Without seats (embedders and tests) nothing is checked or recorded.
   */
  private startGate(): SessionStartExtra | undefined {
    const seats = this.seats;
    if (!seats) return undefined;
    // US-0060: AI players need a consent notice that names them; checked before any seat, so a restart on an older notice cannot start.
    if (this.aiRoleIds().length > 0 && !noticeNamesAiPlayers(seats.consent.notice.version)) throw new HostError("ai_notice");
    // US-0060: a human seat needs a holder and its consent; an AI seat needs a connected bot and no consent. One refusal names the
    // humans first, then the AI roles without a bot (the BFF start route parses this message).
    const ready = (r: string): boolean => !!this.assignments[r] && (this.isAiRole(r) || seats.consent.has(r, this.assignments[r]!));
    const roles = this.playerRoleIds();
    const missing = [...roles.filter((r) => !this.isAiRole(r) && !ready(r)), ...roles.filter((r) => this.isAiRole(r) && !ready(r))];
    if (missing.length > 0) throw new HostError("seats_not_ready", missing);
    const aiRoles = this.aiRoleIds();
    // Defence in depth: an AI role has no consent, so a stray entry for one is never recorded.
    const consents = Object.fromEntries(Object.entries(seats.consent.snapshot()).filter(([r]) => !aiRoles.includes(r)));
    return { consents, names: seats.credentials.names(), logIdentity: seats.credentials.logIdentity, ...(aiRoles.length > 0 ? { aiRoles, includeInGroup: this.includeInGroup() } : {}) };
  }

  /** Serialises everything that mutates the session so NPC turns never interleave. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once everything queued so far (NPC rounds, GM ticks) has finished. */
  idle(): Promise<void> { return this.queue; }

  /** Runs in the background: never awaited by callers, errors go to the log callback. */
  private schedule(what: string, fn: () => Promise<void>): void {
    this.enqueue(fn).catch((err) => this.report(what, err));
  }

  /**
   * Records the line and returns. The NPC round and GM tick are scheduled in the background (one NPC turn at
   * a time via the queue), so a caller, and its connection's next message, never waits behind a model call.
   */
  async onPlayerUtterance(roleId: string, text: string, opts: { expectSceneId?: string } = {}): Promise<void> {
    // BUG-0009: each opening event (session.started, the AI characters, scene.entered, the opening inject) reaches the clients as
    // soon as it is on disk, but `started` turns true only once the last one is written. A line from a page that already shows the
    // scene waits for that start in flight (engine.say would queue behind its mutex anyway); only a failed start refuses it.
    if (!this.started && this.starting !== null) await this.starting.catch(() => undefined);
    if (!this.started) throw new HostError("not_started");
    await this.engine.say(roleId, text, "text", opts); // throws EngineError (paused, ended, ...) before any NPC turn can start
    this.pendingAnswer = null; // a new line supersedes the one from before a restart: the round below answers the conversation as it now stands
    this.turns?.textLine(); // US-0070: a typed line ends a pending voice turn at once (its round is the one scheduled here)
    this.scheduleRound();
  }

  /**
   * US-0070: records a transcribed voice line for the seat's CURRENT human holder who chose voice, as an ordinary `utterance` with
   * `channel: "voice"`, and returns its seq. The second privacy gate (the speech worker is the first): refusals, in order, are voice_off,
   * not_started (after waiting for a start in flight), unknown_role (not an own-property player role: an AI character too), ai_role,
   * not_holder (a reissue, rebind or reconnect since the segment began), not_recording (no choice, text only, another participant's
   * choice, or pinned off), then the engine's own: paused, not_in_scene (between scenes, or a role outside the scene), ended; anything else
   * is failed (a log failure stays fatal through the engine). Nothing is appended for a refusal.
   */
  async onVoiceUtterance(roleId: string, participantId: string, text: string): Promise<{ seq: number }> {
    this.turns?.touch(roleId); // F2: news from a speaking track restarts its backstop
    try { return await this.recordVoiceLine(roleId, participantId, text); }
    catch (err) {
      // AC-0399: a speaker whose line was refused for a reason they can act on is told, privately (rate-limited, never logged).
      if (err instanceof VoiceRefusedError && SPEAKER_NOTICES.has(err.code)) this.voiceNotice(roleId, participantId, err.code as VoiceNoticeCode);
      throw err;
    }
  }

  private async recordVoiceLine(roleId: string, participantId: string, text: string): Promise<{ seq: number }> {
    if (!this.voice.enabled) throw new VoiceRefusedError("voice_off");
    if (!this.started && this.starting !== null) await this.starting.catch(() => undefined);
    if (!this.started) throw new VoiceRefusedError("not_started");
    if (!this.hasPlayerRole(roleId)) throw new VoiceRefusedError("unknown_role");
    if (this.isAiRole(roleId)) throw new VoiceRefusedError("ai_role");
    if (!this.holds(roleId, participantId)) throw new VoiceRefusedError("not_holder");
    // US-0071 (K4): muted or voice unavailable is not recording either; a line still in flight when the mute came is refused.
    if (!this.isRecordingHolder(roleId)) throw new VoiceRefusedError("not_recording");
    let event: SessionEvent;
    const said = this.engine.say(roleId, text, "voice");
    this.voiceChain = this.voiceChain.then((prev) => said.then((e) => Math.max(prev, e.seq), () => prev));
    try { event = await said; }
    catch (err) {
      if (err instanceof EngineError) {
        if (err.code === "paused") throw new VoiceRefusedError("paused");
        if (err.code === "not_in_scene" || err.code === "stale_scene") throw new VoiceRefusedError("not_in_scene");
        if (err.code === "ended") throw new VoiceRefusedError("ended");
      }
      throw new VoiceRefusedError("failed");
    }
    this.pendingAnswer = null; // as a typed line: a new line supersedes the one from before a restart
    // AC-0400: a line that arrives with no speech active and no timer pending ends its own turn; otherwise the turn timer will.
    if (this.turns && !this.turns.open) this.endVoiceTurn();
    return { seq: event.seq };
  }

  /**
   * US-0070 (AC-0400): a speech edge of a recording track (fire-and-forget, from the speech worker through control). Ignored unless voice
   * is on, the session is running and not paused, and the role is a human seat whose current holder chose voice.
   */
  onSpeechActivity(roleId: string, active: boolean, silentMs?: number): void {
    const turns = this.turns;
    if (!turns || !this.started || this.fatal !== null || this.engine.state.paused || this.engine.state.status !== "running") return;
    if (!this.isRecordingHolder(roleId)) return;
    turns.activity(roleId, active, silentMs);
  }

  /**
   * US-0070 (F2): the speech worker stopped, so no speech edge will come again: every speaking role is dropped and an open voice turn
   * closes now (`voice_turn open:false` goes out, the Game Master is no longer held). Its recorded lines still get their round (F1).
   * Never throws.
   */
  voiceWorkerDown(): void {
    try { this.turns?.dropAll(); } catch (err) { this.safeLog(`voice worker down: ${errorName(err)}`); }
  }

  /** US-0070: whether a voice turn is open (someone speaking, or the turn timer pending). */
  get voiceTurnOpen(): boolean { return this.turns?.open ?? false; }

  /** US-0070: the last seq of each voice turn closed in this process (rising). */
  get voiceTurnEnds(): readonly number[] { return this.turns?.closedTurnEnds ?? []; }

  /**
   * US-0070 (AC-0399): tells the seat's speaker, privately, why a segment did not become a line. Sent only when `participantId` still holds
   * the human seat, at most once per role and code per NOTICE_MIN_INTERVAL_MS on the host clock; never logged and never to anyone else.
   * Never throws.
   */
  voiceNotice(roleId: string, participantId: string, code: VoiceNoticeCode): void {
    if (!this.voice.enabled || !this.hasPlayerRole(roleId) || this.isAiRole(roleId) || !this.holds(roleId, participantId)) return;
    const key = `${roleId}\n${code}`;
    const now = this.clock.now();
    const last = this.noticeSentAt.get(key);
    if (last !== undefined && now - last < NOTICE_MIN_INTERVAL_MS) return;
    this.noticeSentAt.set(key, now);
    this.emitVoiceNotice(roleId, code);
  }

  private emitVoiceNotice(roleId: string, code: VoiceNoticeCode): void {
    for (const fn of this.voiceNoticeListeners) { try { fn(roleId, code); } catch (err) { this.safeLog(`voice notice listener: ${errorName(err)}`); } }
  }

  /** US-0070: `fn(roleId, code)` gets every voice notice that passed the checks (the server sends it to that role's live socket). */
  onVoiceNotice(fn: (roleId: string, code: VoiceNoticeCode) => void): () => void { this.voiceNoticeListeners.add(fn); return () => { this.voiceNoticeListeners.delete(fn); }; }

  /**
   * US-0070 (AC-0399, AC-0402): one facilitator-only warning with the FIXED sentence of `code`, at most once per code per
   * ALERT_MIN_INTERVAL_MS (host clock); nothing while voice is off or after the end. Before the start it is kept (F10, one per code) and
   * logged when the session starts. Never rejects.
   */
  async voiceAlert(code: VoiceAlertCode): Promise<void> {
    try {
      if (!this.voice.enabled || this.engine.state.status === "ended") return;
      if (!this.started) { this.keepPendingAlert(code); return; }
      const now = this.clock.now();
      const last = this.alertSentAt.get(code);
      if (last !== undefined && now - last < ALERT_MIN_INTERVAL_MS) return;
      this.alertSentAt.set(code, now);
      await this.engine.alert(VOICE_ALERT_SENTENCES[code], VOICE_ALERT_LEVELS[code]);
    } catch (err) { this.safeLog(`voice alert: ${errorName(err)}`); }
  }

  /** F10: keeps a pre-start alert: one per code (raised again, it moves to the end), at most MAX_PENDING_VOICE_ALERTS (the oldest goes). */
  private keepPendingAlert(code: VoiceAlertCode): void {
    this.pendingAlerts.delete(code);
    this.pendingAlerts.add(code);
    while (this.pendingAlerts.size > MAX_PENDING_VOICE_ALERTS) this.pendingAlerts.delete(this.pendingAlerts.values().next().value!);
  }

  /** F10: at the start, every kept alert becomes a facilitator alert, in the order kept, once (the usual rate limit applies). Never throws. */
  private flushPendingAlerts(): void {
    const codes = [...this.pendingAlerts];
    this.pendingAlerts.clear();
    void codes.reduce<Promise<void>>((p, c) => p.then(() => this.voiceAlert(c)), Promise.resolve());
  }

  /** US-0070: `fn` gets every open and close of a voice turn (for the control service's AI players, `voice_turn`). */
  onVoiceTurn(fn: (open: boolean) => void): () => void { this.voiceTurnListeners.add(fn); return () => { this.voiceTurnListeners.delete(fn); }; }

  /** A human seat whose current holder chose voice (and is not pinned off), has not muted, while voice is available (US-0071, K4). */
  private isRecordingHolder(roleId: string): boolean {
    return this.holderOf(roleId) !== undefined && this.voiceStateOf(roleId) === "voice" && !this.voiceMuted.has(roleId) && !this.voiceUnavailable;
  }

  /**
   * US-0070 (C3): a voice turn ended. Its round starts only once every voice line received so far is recorded (the chain), and not at all
   * when a pause or the end cleared the turn meanwhile, or when no voice line newer than the last answered one was recorded (F1). The turn's last recorded seq becomes a boundary for the Game Master's count.
   */
  private endVoiceTurn(): void {
    const turns = this.turns;
    if (!turns) return;
    const epoch = turns.epoch;
    void this.voiceChain.then((seq) => {
      if (turns.epoch !== epoch || this.fatal !== null) return;
      // F1: a turn that recorded no new line (a dropped, empty or failed segment, a refused line) makes no AI character speak.
      if (seq <= this.lastAnsweredVoiceSeq) return;
      this.lastAnsweredVoiceSeq = seq;
      turns.recordTurnEnd(seq);
      this.scheduleRound();
    });
  }

  /** One NPC round (then a GM tick) in the background. R25: at most one round waits behind the running one; it reads the then-current transcript anyway. */
  private scheduleRound(): void {
    if (this.roundQueued) return;
    this.roundQueued = true;
    this.schedule("npc round", async () => {
      this.roundQueued = false;
      const scene = this.engine.currentScene();
      if (!scene) return;
      const order = this.replyOrder(scene.participants);
      const before = this.engine.state.transcript.length;
      let spoke = false;
      for (const [i, id] of order.entries()) {
        const agent = this.npcs.get(id)!;
        // Nobody has answered yet: the last character of the round must speak, so a player line is never left entirely unanswered.
        try { if (await agent.respond({ mustSpeak: i === order.length - 1 && !spoke })) spoke = true; } catch (err) { this.report(`NPC ${id}`, err); }
      }
      if (order.length > 0 && !spoke && this.engine.state.transcript.length === before && this.engine.currentScene()?.id === scene.id && !this.engine.state.paused && this.engine.state.status === "running") {
        try { await this.engine.alert("every AI character stayed silent for this line", "warning", { expectSceneId: scene.id }); } catch (err) { this.report("silence alert", err); }
      }
      await this.gm.tick();
    });
  }

  /**
   * The AI characters of a scene in reply order: by seniority ascending (junior first, so the senior one reads the junior's reply
   * and answers the players with the decision), ties by the scene's participant order (a stable sort). Deterministic. A scene with one AI character is unaffected.
   */
  private replyOrder(participants: string[]): string[] {
    const seniority = (id: string): number => this.npcs.get(id)?.seniority ?? 3;
    return participants.filter((id) => this.npcs.has(id)).sort((a, b) => seniority(a) - seniority(b));
  }

  /**
   * US-0059: the facilitator ends the session now. Refused before the start (not_started), while the start is in flight or incomplete
   * (starting) and, by the engine, after the end (ended). The message is cleaned here (longer than 300 code points is bad_message;
   * whitespace only means none). Afterwards the ticker stops and a pending answer from before a restart is dropped.
   */
  async endNow(o: { by?: string; message?: string }): Promise<void> {
    if (!this.started) throw new HostError(this.isStarting ? "starting" : "not_started");
    let message: string | undefined;
    try { message = cleanClosingMessage(o.message); } catch (err) {
      if (err instanceof ReviewUsageError) throw new HostError("bad_message");
      throw err;
    }
    await this.engine.endNow({ actor: actorLabel(o.by), ...(message !== undefined ? { message } : {}) });
    this.stopTicker();
    this.pendingAnswer = null;
  }

  async command(cmd: Parameters<SessionEngine["command"]>[0], opts: { expectSceneId?: string; by?: string } = {}): Promise<void> {
    const by = cleanFacilitatorLabel(opts.by);
    await this.engine.command(cmd, { ...(opts.expectSceneId !== undefined ? { expectSceneId: opts.expectSceneId } : {}), ...(by !== undefined ? { by } : {}) });
    if (cmd.command === "resume" && this.pendingAnswer !== null && !this.engine.state.paused) {
      const sceneId = this.pendingAnswer;
      this.pendingAnswer = null; // exactly once, whatever happens next
      // Not when the facilitator has already asked to leave this scene (the advance takes effect at the next tick).
      if (this.engine.currentScene()?.id === sceneId && this.engine.state.status === "running" && !this.engine.state.advanceRequested) {
        await this.engine.alert("answering the last player line from before the restart", "info", { expectSceneId: sceneId });
        this.scheduleRound();
        return; // the round ends with a Game Master tick
      }
    }
    this.schedule("gm tick", () => this.gm.tick());
  }

  /**
   * Waits for one final Game Master evaluation of the current scene (see GameMaster.finalEvaluation), serialised with the
   * NPC rounds. A live run's 1 s ticker can judge while a player's line is being recorded, before the characters' replies.
   */
  evaluateFinal(expectSceneId?: string): Promise<boolean> {
    let ran = false;
    return this.enqueue(async () => { ran = await this.gm.finalEvaluation(expectSceneId); }).then(() => ran);
  }

  startTicker(ms: number): void {
    this.stopTicker();
    if (this.fatal !== null) return;
    this.ticker = setInterval(() => {
      if (this.tickPending) return; // a slow tick must not pile up behind itself
      this.tickPending = true;
      this.enqueue(() => this.gm.tick())
        .catch((err) => this.report("ticker", err))
        .finally(() => { this.tickPending = false; });
    }, ms);
  }
  stopTicker(): void { if (this.ticker) clearInterval(this.ticker); this.ticker = null; }

  /** Subscribers are synchronous inside the engine's emit: a throw would abort the operation, so each is isolated. */
  subscribe(fn: (e: SessionEvent) => void): () => void {
    return this.engine.subscribe((e) => {
      try { fn(e); } catch (err) { this.report("subscriber", err); }
    });
  }

  /** Every AI character's hidden facts, in the order `release_hidden` numbers them. For the facilitator's `joined` message ONLY: never put this in a player's message or log. */
  hiddenFacts(): Record<string, string[]> {
    return Object.fromEntries(Object.values(this.scenario.roles).filter((r): r is NpcRole => r.type === "npc" && r.hidden.length > 0).map((r) => [r.id, [...r.hidden]]));
  }

  /** US-0055: title, goal and time box of only the scenes `roleId` takes part in, in script order (for the player's `joined`). Carries no injects. */
  scenesFor(roleId: string): PlayerScene[] {
    return this.scenario.script.scenes.filter((sc) => sc.participants.includes(roleId)).map((sc) => this.plainScene(sc));
  }

  /** US-0059: every scene in script order with its injects (for the facilitator's `joined` ONLY, never a player's). `atMinute` only when set. */
  allScenes(): FacilitatorScene[] {
    return this.scenario.script.scenes.map((sc) => ({
      ...this.plainScene(sc),
      injects: (sc.injects ?? []).map((i) => ({ id: i.id, to: [...i.to], content: i.content, ...(i.at_minute !== undefined ? { atMinute: i.at_minute } : {}) })),
    }));
  }

  private plainScene(sc: Scenario["script"]["scenes"][number]): PlayerScene {
    return { id: sc.id, title: sc.title, goal: sc.goal, timeBoxMinutes: sc.time_box_minutes };
  }

  /** State snapshot safe to send to `who`: players never get NPC internals, GM verdicts, participant ids or other scenes' lines. */
  snapshotFor(who: "facilitator"): SessionState;
  snapshotFor(who: string): PlayerSnapshot;
  snapshotFor(who: string): SessionState | PlayerSnapshot {
    if (who === "facilitator") return this.engine.state;
    const snap = snapshotForPlayer(this.engine.state, who);
    // BUG-0023: also the floor set at the moment of the reissue itself (the log's alert, which the state fold turns into the same floor after a restart, is appended just after).
    const floor = Object.hasOwn(this.seatReplacedAt, who) ? this.seatReplacedAt[who]! : 0;
    return floor > 0 ? { ...snap, whispers: snap.whispers.filter((w) => w.seq > floor) } : snap;
  }

  /** BUG-0023: the seat of `roleId` goes to a new participant (a post-start reissue): whispers sent so far stay with the old holder. */
  noteSeatReplaced(roleId: string): void { this.seatReplacedAt[roleId] = this.engine.state.lastSeq; }
  private readonly seatReplacedAt: Record<string, number> = Object.create(null) as Record<string, number>;

  /**
   * US-0013: the events after `afterSeq` that `who` may see, through the SAME viewFor as live delivery (default-deny), from the engine's
   * in-memory window. Synchronous: a caller that takes the replay and subscribes in the same tick gets every later event exactly once.
   * Bounded: at most the retained window is scanned, and at most `maxEvents` / `maxBytes` are returned (else `complete: false`, no events).
   * Throws RangeError when `afterSeq` is not a whole number from 0 to the last event's seq (callers validate input first).
   */
  replayFor(who: string | "facilitator", afterSeq: number, o: { maxEvents?: number; maxBytes?: number } = {}): Replay {
    const toSeq = this.engine.state.lastSeq;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > toSeq) throw new RangeError("afterSeq must be a whole number from 0 to the last event's seq");
    const maxEvents = o.maxEvents ?? MAX_REPLAY_EVENTS;
    const maxBytes = o.maxBytes ?? MAX_REPLAY_BYTES;
    const incomplete: Replay = { afterSeq, toSeq, complete: false, events: [] };
    const src = this.engine.eventsAfter(afterSeq);
    if (!src.complete) return incomplete;
    const events: SessionEvent[] = [];
    let bytes = 0;
    for (const e of src.events) {
      const view = this.viewFor(who, e);
      if (!view) continue;
      bytes += Buffer.byteLength(JSON.stringify(view));
      if (events.length >= maxEvents || bytes > maxBytes) return incomplete; // never a partial replay: that would leave a gap
      events.push(view);
    }
    return { afterSeq, toSeq, complete: true, events };
  }

  /** The scene an utterance was spoken in (binary search: the transcript is in seq order), or undefined for an unknown seq. */
  private utteranceScene(seq: number): string | null | undefined {
    const t = this.engine.state.transcript;
    let lo = 0; let hi = t.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const u = t[mid]!;
      if (u.seq === seq) return u.sceneId;
      if (u.seq < seq) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }

  filterFor(who: string | "facilitator"): (e: SessionEvent) => boolean {
    return (e) => this.viewFor(who, e) !== null;
  }

  /**
   * What `who` may see of `e`, or null. Default-DENY for players: an explicit decision per event type, and the
   * `never` check below makes a new EventBody member a compile error until it is decided here.
   * Also the filter of replay-from-seq (US-0013). It reads the current state, which only grows (scenes are appended to sceneHistory,
   * lines to the transcript), so a past event gets the same answer now as when it was delivered live.
   */
  viewFor(who: string | "facilitator", e: SessionEvent): SessionEvent | null {
    if (who === "facilitator") return e;
    const inScene = (sceneId: string | null | undefined) =>
      this.engine.state.sceneHistory.find((s) => s.id === sceneId)?.participants.includes(who) ?? false;
    switch (e.type) {
      // Default-deny: the player copy is built from the allowlists in player-copies.ts (STARTED_FOR_PLAYERS) (a new event field is a compile error until decided),
      // with roles reduced to kinds and only the player's own consent. Names and unknown keys never reach a player. The log identity is not
      // copied here either, but it is not a secret: a player's `joined` carries it so a web client can tell a new log apart.
      case "session.started": return startedForPlayer(e, who);
      case "session.ended": return endedForPlayer(e);
      // Like a pause: every participant learns the session came back paused after a restart.
      case "session.resumed": return e;
      // Only for scenes the player takes part in.
      case "scene.entered": return e.participants.includes(who) ? e : null;
      case "scene.exited": return inScene(e.sceneId) ? e : null;
      case "utterance": return inScene(this.utteranceScene(e.seq)) ? e : null;
      // Only when addressed to this role.
      case "inject.fired": return e.to.includes(who) ? e : null;
      // Facilitator controls: players learn of pause/resume and of whispers addressed to them; everything else
      // (advance, fire_inject, set_npc_stance with NPC goals, release_hidden) stays private.
      case "facilitator.command": return commandForPlayer(e, who);
      // Never for players: NPC goals/knowledge and released hidden facts, GM reasoning, facilitator alerts.
      // US-0034: a Game Master release suggestion (or auto-release) names a hidden fact by number and is the facilitator's decision alone.
      case "npc.updated": case "gm.decision": case "gm.no_verdict": case "gm.fact_earned": case "facilitator.alert": return null;
      default: {
        const _exhaustive: never = e; // compile time: a new EventBody member must be decided above
        void _exhaustive;
        return null; // runtime: fail closed on an event type this version does not know
      }
    }
  }
}

/** An error's name only (a message could quote a path or a value). */
function errorName(err: unknown): string { return err instanceof Error ? err.name : "error"; }
