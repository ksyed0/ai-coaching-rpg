/** What a member of the floor is told: another AI player said a nudge in `sceneId`, or the floor became free (a nudge in flight failed). */
export type FloorMember = { nudged: (sceneId: string) => void; free: () => void };

/**
 * US-0081 (AC-0471): the nudge floor of ONE session, shared by its AI players (in memory, like the budget). At most one AI player holds it
 * while its nudge is in flight, so two bots that wake at the same instant never both nudge. When the holder's nudge is SAID, every other
 * member is told (`nudged`), and each bot's own policy then allows no nudge until a human line arrives in the scene; when it is not said
 * (skipped, dropped, the bot stopped), the floor is free again and the members re-arm. Callbacks never throw into the caller.
 */
export class NudgeFloor {
  private holder: string | null = null;
  private readonly members = new Map<string, FloorMember>();

  /** Registers a bot; returns its leave function (which also frees the floor if the bot held it). */
  join(roleId: string, m: FloorMember): () => void {
    this.members.set(roleId, m);
    return () => { if (this.members.get(roleId) === m) this.members.delete(roleId); this.release(roleId); };
  }

  /** True when `roleId` now holds the floor (it was free or already its own). */
  claim(roleId: string): boolean {
    if (this.holder !== null && this.holder !== roleId) return false;
    this.holder = roleId;
    return true;
  }

  /** The holder's nudge was not said: the floor is free and the other members re-arm. A non-holder's release is a no-op. */
  release(roleId: string): void {
    if (this.holder !== roleId) return;
    this.holder = null;
    this.tell(roleId, (m) => m.free());
  }

  /** The holder's nudge was said in `sceneId`: the floor is free, and every other member learns that the scene has had its nudge. */
  spoke(roleId: string, sceneId: string): void {
    if (this.holder === roleId) this.holder = null;
    this.tell(roleId, (m) => m.nudged(sceneId));
  }

  get heldBy(): string | null { return this.holder; }

  private tell(except: string, fn: (m: FloorMember) => void): void {
    for (const [r, m] of [...this.members]) {
      if (r === except) continue;
      try { fn(m); } catch { /* one member's failure never stops the others */ }
    }
  }
}
