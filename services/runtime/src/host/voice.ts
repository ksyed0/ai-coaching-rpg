/**
 * US-0070 (EPIC-0003 voice A1a): the host's voice helpers that need no host internals. `buildVoiceSeats` is what the runtime reports to
 * the control service as `voice_seats` (overview section 2), and control forwards it to the speech worker as `voice_state`: the worker
 * segments and transcribes ONLY a track whose holder has `recording: true` (the privacy invariant; the host checks again on every line).
 */
export type VoiceHolder = { roleId: string; participantId: string; recording: boolean };
export type VoiceSeats = { paused: boolean; ended: boolean; holders: VoiceHolder[] };
export type VoiceState = "none" | "voice" | "text_only" | "off";

/**
 * Every HUMAN player role that has a holder, in the scenario's player order (never an AI seat, never an AI character), with `recording`
 * true only when the seat's voice state is `voice`. Pure over what the host passes in.
 */
export function buildVoiceSeats(o: {
  playerRoles: readonly string[]; holderOf: (roleId: string) => string | undefined; isAi: (roleId: string) => boolean;
  stateOf: (roleId: string) => VoiceState; paused: boolean; ended: boolean;
}): VoiceSeats {
  const holders: VoiceHolder[] = [];
  for (const roleId of o.playerRoles) {
    if (o.isAi(roleId)) continue;
    const participantId = o.holderOf(roleId);
    if (participantId === undefined) continue;
    holders.push({ roleId, participantId, recording: o.stateOf(roleId) === "voice" });
  }
  return { paused: o.paused, ended: o.ended, holders };
}

/** An injected one-shot timer (the Supervisor's shape): schedules `fn` after `ms` and returns its cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

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
  /** The pending timer's token (identity) and cancel function; a fire whose token is no longer current does nothing. */
  private timer: { cancel: () => void } | null = null;
  private wasOpen = false;
  private readonly ends: number[] = [];
  private epochN = 0;

  constructor(private readonly o: { turnEndMs: number; setTimer: SetTimer; onTurnEnd: () => void; onOpenChange: (open: boolean) => void }) {}

  get open(): boolean { return this.active.size > 0 || this.timer !== null; }

  /** Bumped by every `clear`: a turn end that was waiting for its lines checks it, so a pause or the end in between starts no round. */
  get epoch(): number { return this.epochN; }

  /** The last seq of each closed voice turn, rising (for the Game Master's count, gmUnits). In memory only: a restart starts empty. */
  get closedTurnEnds(): readonly number[] { return this.ends; }

  /** A speech edge of a recording track. */
  activity(roleId: string, active: boolean, silentMs?: number): void {
    if (active) { this.cancel(); this.active.add(roleId); }
    else {
      this.active.delete(roleId);
      if (this.active.size === 0) this.arm(Math.max(0, this.o.turnEndMs - (silentMs ?? 0)));
    }
    this.notify();
  }

  /** A track that may no longer record (opt-out, a lost seat): it stops holding the turn open; the last one arms the timer from now. */
  forget(roleId: string): void {
    if (!this.active.delete(roleId)) return;
    if (this.active.size === 0) this.arm(this.o.turnEndMs);
    this.notify();
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
    this.active.clear();
    this.epochN++;
    this.notify();
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
