/** The timing and cap settings of one live AI player's turns (the policy class itself comes with the bot). */
export type TurnSettings = { minGapMs: number; nudgeMs: number; linesPerScene: number; settleMs: number };
export const DEFAULT_TURN_SETTINGS: TurnSettings = { minGapMs: 15_000, nudgeMs: 90_000, linesPerScene: 10, settleMs: 6_000 };
/** What made the AI player speak: a reply to a line, a nudge after a quiet spell, or the facilitator's prompt. */
export type Trigger = "reply" | "nudge" | "prompt";

/** What the bot's room feed tells the policy. `ai` = the speaker is an AI player (self included); `replayed` = seeded from the joined snapshot. */
export type PolicyEvent =
  | { kind: "started" }
  | { kind: "scene"; sceneId: string; participants: string[] }
  | { kind: "line"; roleId: string; ai: boolean; replayed?: true }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "ended" }
  | { kind: "humans"; connected: boolean };

/** One begun turn. It is current only until the policy pauses, changes scene, ends or resets, or the turn finishes. */
export type TurnTicket = { epoch: number; sceneId: string; trigger: Trigger };

/**
 * The reactive turn policy of one live AI player: a pure state machine. No timers and no I/O; time comes only from
 * the injected `now()`, and the caller sleeps until `wakeAt()` and then asks `due()`.
 */
export class TurnPolicy {
  private readonly roleId: string;
  private readonly settings: TurnSettings;
  private readonly now: () => number;
  private started = false;
  private ended = false;
  private paused = false;
  private sceneId: string | null = null;
  private inScene = false;
  private pending = false;
  private humans = false;
  private held = false;
  private flying = false;
  private epoch = 0;
  private lines = 0;
  private lastActivityAt = 0;
  private lastSpokeAt: number | null = null;

  constructor(o: { roleId: string; settings: TurnSettings; now: () => number }) {
    this.roleId = o.roleId;
    this.settings = o.settings;
    this.now = o.now;
  }

  get inFlight(): boolean { return this.flying; }
  get linesThisScene(): number { return this.lines; }

  private get active(): boolean { return this.started && !this.ended && !this.paused && this.sceneId !== null && this.inScene; }

  private invalidate(): void { this.epoch += 1; this.flying = false; }

  observe(e: PolicyEvent): void {
    switch (e.kind) {
      case "started":
        this.started = true;
        this.lastActivityAt = this.now();
        return;
      case "scene":
        this.sceneId = e.sceneId;
        this.inScene = e.participants.includes(this.roleId);
        this.lines = 0;
        this.pending = false;
        this.lastActivityAt = this.now();
        this.invalidate();
        return;
      case "line":
        if (e.replayed) return; // history only: it neither wakes the bot nor moves the quiet clock
        this.lastActivityAt = this.now();
        if (this.active && !e.ai && e.roleId !== this.roleId) this.pending = true;
        return;
      case "paused":
        this.paused = true;
        this.invalidate();
        return;
      case "resumed":
        if (!this.paused) return;
        this.paused = false;
        this.pending = false;
        this.lastActivityAt = this.now();
        return;
      case "ended":
        this.ended = true;
        this.pending = false;
        this.invalidate();
        return;
      case "humans":
        this.humans = e.connected;
        return;
    }
  }

  /** The instant the reply or nudge becomes allowed, ignoring held and in flight; null when neither is possible. */
  private deadline(): { trigger: "reply" | "nudge"; at: number } | null {
    if (!this.active || this.lines >= this.settings.linesPerScene) return null;
    const gap = this.lastSpokeAt === null ? -Infinity : this.lastSpokeAt + this.settings.minGapMs;
    if (this.pending) return { trigger: "reply", at: Math.max(this.lastActivityAt + this.settings.settleMs, gap) };
    if (this.humans) return { trigger: "nudge", at: Math.max(this.lastActivityAt + this.settings.nudgeMs, gap) };
    return null;
  }

  due(): { trigger: "reply" | "nudge" } | null {
    if (this.held || this.flying) return null;
    const d = this.deadline();
    return d && this.now() >= d.at ? { trigger: d.trigger } : null;
  }

  /** When to call `due()` next: a value at or before now means due now; null means nothing can become due on its own
   *  (the caller re-asks after the next event, `finish` or `setHeld`). */
  wakeAt(): number | null {
    if (this.held || this.flying) return null;
    return this.deadline()?.at ?? null;
  }

  begin(trigger: Trigger): TurnTicket | null {
    if (!this.active || this.flying || this.sceneId === null) return null;
    if (trigger !== "prompt" && this.held) return null;
    this.flying = true;
    return { epoch: this.epoch, sceneId: this.sceneId, trigger };
  }

  isCurrent(t: TurnTicket): boolean { return this.flying && t.epoch === this.epoch; }

  /** A stale ticket is ignored entirely (the runtime dropped its line). A current one frees the bot; a reply attempt
   *  consumes the pending reply and a nudge attempt restarts the quiet clock, so a skipped turn never spins. */
  finish(t: TurnTicket, spoke: boolean): void {
    if (!this.isCurrent(t)) return;
    this.flying = false;
    if (spoke) {
      this.lastSpokeAt = this.now();
      this.lines += 1;
      this.pending = false;
    } else if (t.trigger === "reply") {
      this.pending = false;
    } else if (t.trigger === "nudge") {
      this.lastActivityAt = this.now();
    }
  }

  setHeld(held: boolean): void { this.held = held; }

  /** Forget the room (a reconnect re-seeds it). The hold belongs to the host and is kept. */
  reset(): void {
    this.started = false;
    this.ended = false;
    this.paused = false;
    this.sceneId = null;
    this.inScene = false;
    this.pending = false;
    this.humans = false;
    this.lines = 0;
    this.lastActivityAt = 0;
    this.lastSpokeAt = null;
    this.invalidate();
  }
}
