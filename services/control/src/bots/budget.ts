/**
 * US-0060: the model-call budget of ONE session (the AI players of a session share it). `take()` consumes one unit only when one is
 * left, so `used` never exceeds the limit. A restarted service seeds `used` from the calls already in the session log.
 */
export class SessionBudget {
  private count: number;
  /** Set by the host once the facilitator has been told the budget is used up (once per session). */
  budgetAlerted = false;

  constructor(private readonly limit: number, used = 0) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    this.limit = cap;
    this.count = Number.isFinite(used) ? Math.min(cap, Math.max(0, Math.floor(used))) : 0;
  }

  take(): boolean {
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  get used(): number { return this.count; }
  get exhausted(): boolean { return this.count >= this.limit; }
}
