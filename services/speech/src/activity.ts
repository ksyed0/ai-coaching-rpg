import { MAX_SILENT_MS, type WorkerMessage } from "./protocol.js";

/**
 * US-0070 (overview C3): the per-role speech edges the runtime's turn timer runs on. `active: true` goes out once per onset; the
 * "speech stopped" edge goes out only AFTER the closing segment's outcome (its line or its failure) has been sent, carrying `silentMs`
 * (how long the track has been silent by then), so the runtime never ends a turn before its last line arrived. A role that starts
 * speaking again before that outcome keeps its `true` and the stale close sends nothing. `stop` (opt-out, pause, a lost seat) closes the
 * edge at once with `silentMs: 0`.
 */
export class ActivityReporter {
  /** The last edge sent per role (absent: false). */
  private readonly onWire = new Map<string, boolean>();
  /** Bumped on every onset and stop; a pending close only sends when its generation is still current. */
  private readonly generation = new Map<string, number>();

  constructor(private readonly send: (m: WorkerMessage) => void, private readonly now: () => number) {}

  speechStarted(roleId: string): void {
    this.bump(roleId);
    if (this.onWire.get(roleId) === true) return;
    this.onWire.set(roleId, true);
    this.send({ type: "speech_activity", roleId, active: true });
  }

  /** A segment closed on silence (or was dropped as too short); `lastSpeechAt` is its last speech frame on the wall clock. */
  segmentClosed(roleId: string, lastSpeechAt: number, outcomeSent: Promise<void>): void {
    const gen = this.generation.get(roleId) ?? 0;
    const after = (): void => {
      if ((this.generation.get(roleId) ?? 0) !== gen || this.onWire.get(roleId) !== true) return;
      this.onWire.set(roleId, false);
      const silentMs = Math.min(MAX_SILENT_MS, Math.max(0, Math.round(this.now() - lastSpeechAt)));
      this.send({ type: "speech_activity", roleId, active: false, silentMs });
    };
    outcomeSent.then(after, after);
  }

  stop(roleId: string): void {
    this.bump(roleId);
    if (this.onWire.get(roleId) !== true) return;
    this.onWire.set(roleId, false);
    this.send({ type: "speech_activity", roleId, active: false, silentMs: 0 });
  }

  private bump(roleId: string): void { this.generation.set(roleId, (this.generation.get(roleId) ?? 0) + 1); }
}
