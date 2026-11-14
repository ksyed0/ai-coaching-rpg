/**
 * US-0082: who is composing a reply right now (an AI character's model call in this runtime, or a live AI player's turn reported by its
 * bot). A SHORT-LIVED signal held in memory only: it is never an event, never written to the session log, never replayed, resumed,
 * evaluated or reported. A restart forgets it (nobody is thinking after a restart). The frames it produces are `activity` server
 * messages, sent by the WebSocket server to the facilitator and to the players who share the current scene with the speaker.
 */

export type ActivityState = "thinking" | "idle";
/** Why a turn ended without a line (facilitator only): the model timed out, or it failed or was unusable. */
export type ActivityOutcome = "timed_out" | "failed";
export const ACTIVITY_OUTCOMES: readonly ActivityOutcome[] = ["timed_out", "failed"];
/** The frame as the facilitator receives it. A player gets `activityForPlayer` of it: roleId and state, never the outcome. */
export type ActivityFrame = { type: "activity"; roleId: string; state: ActivityState; outcome?: ActivityOutcome };

/** A thinking entry older than this is stale (a lost end): it is no longer reported to a new viewer. The browser clears its own after the same time. */
export const ACTIVITY_MAX_MS = 120_000;

/** The player copy, built key by key: never the outcome (a model failure is the facilitator's business) or any later field. */
export function activityForPlayer(f: ActivityFrame): ActivityFrame {
  return { type: "activity", roleId: f.roleId, state: f.state };
}

export class ActivityBoard {
  private readonly thinking = new Map<string, number>();
  private readonly listeners = new Set<(f: ActivityFrame) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `roleId` began composing a reply. A repeat while already thinking restarts its clock and tells nobody again. */
  begin(roleId: string): void {
    const had = this.thinking.has(roleId);
    this.thinking.set(roleId, this.now());
    if (!had) this.emit({ type: "activity", roleId, state: "thinking" });
  }

  /** `roleId` stopped (its line landed, it stayed silent, timed out or was skipped). A role that was not thinking tells nobody. */
  end(roleId: string, outcome?: ActivityOutcome): void {
    if (!this.thinking.delete(roleId)) return;
    this.emit(outcome !== undefined ? { type: "activity", roleId, state: "idle", outcome } : { type: "activity", roleId, state: "idle" });
  }

  /** Everyone stops (the scene changed, the session ended or the log failed). */
  clear(): void { for (const roleId of [...this.thinking.keys()]) this.end(roleId); }

  isThinking(roleId: string): boolean { return this.thinking.has(roleId); }

  /** The roles thinking now and not stale, for a viewer that joins mid-turn. */
  current(): string[] {
    const t = this.now();
    return [...this.thinking].filter(([, since]) => t - since < ACTIVITY_MAX_MS).map(([roleId]) => roleId);
  }

  /** Calls `fn` for every change from now on; returns the unsubscribe function. A throwing listener never breaks the others. */
  onChange(fn: (f: ActivityFrame) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private emit(f: ActivityFrame): void {
    for (const fn of this.listeners) { try { fn(f); } catch { /* a listener must never break a turn */ } }
  }
}
