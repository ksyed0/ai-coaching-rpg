/**
 * US-0070 (EPIC-0003 voice A1a): the host's voice helpers that need no host internals. `buildVoiceSeats` is what the runtime reports to
 * the control service as `voice_seats` (overview section 2), and control forwards it to the speech worker as `voice_state`: the worker
 * segments and transcribes ONLY a track whose holder has `recording: true` (the privacy invariant; the host checks again on every line).
 */
import type { VoiceAlertCode } from "./parent-channel.js";

/**
 * US-0071 (A1b Task 5): `voiceChosen` is the seat's choice alone (state `voice`), whatever started, pause, mute and availability say:
 * control derives the seat's expected LiveKit identity from it. `open` lists the human player roles with no holder that were NOT given up
 * (no leave, withdrawal, reissue or removal since the last bind; never an AI seat): the same person may come back, so control keeps their
 * LiveKit identity in the seat's room. Every other way of losing a holder removes it (R7).
 */
export type VoiceHolder = { roleId: string; participantId: string; recording: boolean; voiceChosen: boolean };
export type VoiceSeats = { paused: boolean; ended: boolean; holders: VoiceHolder[]; open: string[] };
export type VoiceState = "none" | "voice" | "text_only" | "off";
/**
 * US-0070 (overview section 2): why a speaker's segment did not become a line, told to that speaker alone as `voice_notice` (never logged,
 * never to anyone else). `stt_failed` and `empty` come from the speech worker; the others are the runtime's own refusals. US-0071 (K7):
 * `voice_unavailable` and `voice_available` are the truth about whether the seat's speech can be captured, sent to a voice holder on each
 * transition of control's `voice_availability` (and `voice_unavailable` also on a bind or an opt-in while unavailable); the page must
 * follow them (Tasks 11, 14). The web app allowlists exactly these codes.
 */
export const VOICE_NOTICE_CODES = ["stt_failed", "empty", "paused", "not_in_scene", "ended", "not_recording", "voice_unavailable", "voice_available"] as const;
export type VoiceNoticeCode = (typeof VOICE_NOTICE_CODES)[number];

/**
 * US-0070: the facilitator's voice alerts, fixed sentences (never a value, a path or a transcript). US-0071 (R14) moved the table here,
 * a module with no host dependencies, so the web console can pin its allowlist against it without importing the session host.
 */
export const VOICE_ALERT_SENTENCES: Readonly<Record<VoiceAlertCode, string>> = {
  worker_down: "Voice input stopped: the speech worker is not running. Participants can continue by text.",
  stt_unavailable: "Voice input is unavailable: the speech-to-text server does not answer.",
  stt_failed: "A spoken line could not be transcribed; the speaker was told.",
  worker_restarting: "Voice input is restarting after a fault.",
  voice_off: "Voice input is off for this session after repeated faults. Participants can continue by text.",
  stt_recovered: "Voice input is available again.",
};
/** US-0071 (K8): the level each voice alert is raised at; only the recovery is good news. */
export const VOICE_ALERT_LEVELS: Readonly<Record<VoiceAlertCode, "info" | "warning">> = {
  worker_down: "warning", stt_unavailable: "warning", stt_failed: "warning", worker_restarting: "warning", voice_off: "warning", stt_recovered: "info",
};

/**
 * Every HUMAN player role that has a holder, in the scenario's player order (never an AI seat, never an AI character), with `recording`
 * true only when the session has started, voice is available (US-0071, K4: no worker or speech-to-text fault, not switched off), the
 * seat's voice state is `voice` and its holder has not muted. Pure over what the host passes in.
 */
export function buildVoiceSeats(o: {
  playerRoles: readonly string[]; holderOf: (roleId: string) => string | undefined; isAi: (roleId: string) => boolean;
  stateOf: (roleId: string) => VoiceState; paused: boolean; ended: boolean;
  started: boolean; isMuted: (roleId: string) => boolean; unavailable: boolean;
  /** US-0071: the role's last holder gave the seat up (leave, withdrawal, reissue, removal) and nobody has bound it since. */
  isVacated: (roleId: string) => boolean;
}): VoiceSeats {
  const holders: VoiceHolder[] = [];
  const open: string[] = [];
  for (const roleId of o.playerRoles) {
    if (o.isAi(roleId)) continue;
    const participantId = o.holderOf(roleId);
    if (participantId === undefined) { if (!o.isVacated(roleId)) open.push(roleId); continue; }
    const voiceChosen = o.stateOf(roleId) === "voice";
    holders.push({ roleId, participantId, recording: o.started && !o.unavailable && voiceChosen && !o.isMuted(roleId), voiceChosen });
  }
  return { paused: o.paused, ended: o.ended, holders, open };
}

/** An injected one-shot timer (the Supervisor's shape): schedules `fn` after `ms` and returns its cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

/**
 * US-0070 (F2, review fix wave): how long a speaking track may go with no news (no edge and no line) before the tracker forgets it, so a
 * worker that died mid-speech, or a lost "speech stopped" edge, cannot hold the voice turn open for the rest of the session. A live track
 * sends a line at least every VOICE_MAX_SEGMENT_MS of speech (at most 6000) plus the speech-to-text deadline (STT_DEADLINE_MS, 5000);
 * one more second of slack for the two IPC hops. A cold model's first answer may come later: that line then ends its own turn.
 */
export const VOICE_ACTIVITY_STALE_MS = 12_000;

/**
 * US-0071 (A1b review finding 5): speech-edge-driven changes of who is speaking reach the facilitator's roster at most once per this
 * many ms (trailing edge: the state at the end of the window is what is sent), so a speaker whose edges flap costs one roster frame
 * per window per facilitator socket, not one per edge. The facilitator sees speaking with up to this much delay. A change that does
 * not come from a speech edge (mute, opt-out, a release, pause, the end) is sent at once.
 */
export const SPEAKING_BROADCAST_MS = 250;

/** The default SetTimer: a real timer that never keeps the process alive. */
export const realSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };

/**
 * US-0070 (AC-0400): the host's ONE voice-turn timer (spec 7.5, overview C3). A turn is open while any recording track is speaking or the
 * timer is pending. When every track is silent the timer arms for `max(0, turnEndMs - silentMs)` (silentMs: how long the track has already
 * been silent when its "speech stopped" edge arrived), so the turn ends TURN_END_MS after the last speech frame; new speech on any track
 * cancels it. A fired timer calls `onTurnEnd`; `textLine` ends a pending turn at once; `clear` (pause, end) closes the turn WITHOUT
 * `onTurnEnd`. `onOpenChange` fires only on a change. Pure over the injected timer: no clock, no real time.
 */
export class VoiceTurnTracker {
  private readonly active = new Set<string>();
  /** F2: the backstop timer of each speaking role (only with `staleMs`); its token tells a stale fire from the current one. */
  private readonly stale = new Map<string, { cancel: () => void }>();
  /** The pending timer's token (identity) and cancel function; a fire whose token is no longer current does nothing. */
  private timer: { cancel: () => void } | null = null;
  private wasOpen = false;
  private readonly ends: number[] = [];
  private epochN = 0;

  /**
   * `staleMs` (F2): forget a speaking role after this long with no news from it (see VOICE_ACTIVITY_STALE_MS); absent, never.
   * `onActiveChange` (US-0071): called after any call that may have changed who is speaking (the caller compares; it may be a no-op);
   * `edge` is true for a speech edge (`activity`), false for everything else (forget, the stale backstop, dropAll, clear).
   */
  constructor(private readonly o: { turnEndMs: number; setTimer: SetTimer; onTurnEnd: () => void; onOpenChange: (open: boolean) => void; staleMs?: number; onActiveChange?: (edge: boolean) => void }) {}

  get open(): boolean { return this.active.size > 0 || this.timer !== null; }

  /** Bumped by every `clear`: a turn end that was waiting for its lines checks it, so a pause or the end in between starts no round. */
  get epoch(): number { return this.epochN; }

  /** The last seq of each closed voice turn, rising (for the Game Master's count, gmUnits). In memory only: a restart starts empty. */
  get closedTurnEnds(): readonly number[] { return this.ends; }

  /** A speech edge of a recording track. */
  activity(roleId: string, active: boolean, silentMs?: number): void {
    if (active) { this.cancel(); this.active.add(roleId); this.watch(roleId); }
    else {
      this.unwatch(roleId);
      this.active.delete(roleId);
      if (this.active.size === 0) this.arm(Math.max(0, this.o.turnEndMs - (silentMs ?? 0)));
    }
    this.notify();
    this.o.onActiveChange?.(true);
  }

  /** A track that may no longer record (opt-out, a lost seat): it stops holding the turn open; the last one arms the timer from now. */
  forget(roleId: string): void {
    this.unwatch(roleId);
    if (!this.active.delete(roleId)) return;
    if (this.active.size === 0) this.arm(this.o.turnEndMs);
    this.notify();
    this.o.onActiveChange?.(false);
  }

  /** News from a speaking track (a line arrived): its backstop starts again. Nothing for a role that is not speaking. */
  touch(roleId: string): void { if (this.active.has(roleId)) this.watch(roleId); }

  /**
   * F2: the speech worker is gone, so no edge will ever come: every speaking role is dropped and an open turn ends NOW (`onTurnEnd`; the
   * host runs its round only when the turn recorded a line). Nothing when no turn is open.
   */
  dropAll(): void {
    if (!this.open) return;
    for (const r of [...this.active]) this.unwatch(r);
    this.active.clear();
    this.cancel();
    this.notify();
    this.o.onActiveChange?.(false);
    this.o.onTurnEnd();
  }

  /** Whether `roleId` is speaking (its last edge was `active: true`). */
  isActive(roleId: string): boolean { return this.active.has(roleId); }

  /** The roles currently speaking. */
  activeRoles(): string[] { return [...this.active]; }

  /** A typed line: a pending turn ends at once (the caller schedules its own round). A turn whose speaker is still talking stays open. */
  textLine(): void {
    if (this.timer === null) return;
    this.cancel();
    this.notify();
    this.o.onTurnEnd();
  }

  /** Pause or end: no timer, nobody speaking, no onTurnEnd. */
  clear(): void {
    this.cancel();
    for (const r of [...this.active]) this.unwatch(r);
    this.active.clear();
    this.epochN++;
    this.notify();
    this.o.onActiveChange?.(false);
  }

  /** Records the last seq of a closed turn; only a rising boundary is kept. */
  recordTurnEnd(seq: number): void {
    if (seq > (this.ends.at(-1) ?? 0)) this.ends.push(seq);
  }

  private arm(ms: number): void {
    this.cancel();
    const token: { cancel: () => void } = { cancel: () => {} };
    token.cancel = this.o.setTimer(() => {
      if (this.timer !== token) return; // cancelled, or replaced by a later timer
      this.timer = null;
      this.notify();
      this.o.onTurnEnd();
    }, ms);
    this.timer = token;
  }

  private watch(roleId: string): void {
    const ms = this.o.staleMs;
    if (ms === undefined) return;
    this.unwatch(roleId);
    const token: { cancel: () => void } = { cancel: () => {} };
    token.cancel = this.o.setTimer(() => {
      if (this.stale.get(roleId) !== token) return; // news came, or the role stopped, meanwhile
      this.stale.delete(roleId);
      this.forget(roleId);
    }, ms);
    this.stale.set(roleId, token);
  }

  private unwatch(roleId: string): void {
    const t = this.stale.get(roleId);
    if (!t) return;
    this.stale.delete(roleId);
    t.cancel();
  }

  private cancel(): void {
    const t = this.timer;
    this.timer = null;
    t?.cancel();
  }

  private notify(): void {
    const open = this.open;
    if (open === this.wasOpen) return;
    this.wasOpen = open;
    this.o.onOpenChange(open);
  }
}

/**
 * US-0070 (AC-0400, spec 7.5, overview C7): how many units of conversation a scene's lines are for the Game Master's cadence. A non-voice
 * line (typed, or an AI character's) is one unit. A voice line with seq above `knownFrom` belongs to the turn closed by the first boundary
 * at or above its seq; each closed turn holding at least one of the scene's voice lines is one unit, and a voice line after the last
 * boundary is in a turn still open (none). Lines up to `knownFrom` (before a restart: no boundary of theirs is known) count by runs: each
 * maximal run of consecutive voice lines is one unit. So the count never falls as lines and boundaries are added, and never counts more
 * than the turns there were. `lines` and `closedTurnEnds` are in rising seq order; `knownFrom` defaults to every line (runs only).
 */
export function gmUnits(lines: readonly { seq: number; channel: string }[], closedTurnEnds: readonly number[], knownFrom = Number.POSITIVE_INFINITY): number {
  let units = 0;
  let inRun = false;
  let b = 0;
  let lastTurn = -1;
  for (const l of lines) {
    if (l.channel !== "voice") { units++; inRun = false; continue; }
    if (l.seq <= knownFrom) { if (!inRun) { units++; inRun = true; } continue; }
    inRun = false;
    while (b < closedTurnEnds.length && closedTurnEnds[b]! < l.seq) b++;
    if (b === closedTurnEnds.length) continue; // the open turn
    if (b !== lastTurn) { units++; lastTurn = b; }
  }
  return units;
}
