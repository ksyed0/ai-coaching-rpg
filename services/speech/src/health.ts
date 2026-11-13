import type { SpeechToText } from "@acr/adapters";
import type { WorkerMessage } from "./protocol.js";

/** STT_HEALTH_POLL_MS: how often the worker asks the speech-to-text server whether it answers. */
export const STT_HEALTH_POLL_MS = 5000;
/**
 * Batch 2 review F9 (hysteresis): this many consecutive polls must agree on a new value before it is reported, so a flapping server does
 * not flood the pages with voice_unavailable / voice_available pairs (a change takes 10 s to be seen).
 */
export const STT_HEALTH_CONFIRM = 2;

/**
 * US-0071 (EPIC-0003 voice A1b, Task 9, AC-0411): polls `stt.health()` every STT_HEALTH_POLL_MS and sends `stt_health { ok }` only when
 * the value differs from the last one reported (at first: `initial`, this worker's own warm-up result, which control already has from
 * `worker_ready`) on STT_HEALTH_CONFIRM consecutive polls. The next poll is armed only after the previous one settled, so a slow health
 * call never stacks; a health call that throws counts as unhealthy. `health()` takes no speech-to-text slot and never changes the
 * limiter's warm or cold state (pinned in limited.test.ts). Nothing here logs.
 */
export class HealthPoller {
  private last: boolean;
  private streak = 0;
  private cancel?: () => void;
  private stopped = false;
  private started = false;

  constructor(private readonly o: { stt: SpeechToText; setTimer: (fn: () => void, ms: number) => () => void; send: (m: WorkerMessage) => void; initial: boolean }) {
    this.last = o.initial;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    const c = this.cancel;
    delete this.cancel;
    c?.();
  }

  private arm(): void {
    if (this.stopped) return;
    const cancel = this.o.setTimer(() => {
      if (this.cancel !== cancel) return;
      delete this.cancel;
      void this.poll();
    }, STT_HEALTH_POLL_MS);
    this.cancel = cancel;
  }

  private async poll(): Promise<void> {
    let ok: boolean;
    try { ok = (await this.o.stt.health()) === true; } catch { ok = false; }
    if (this.stopped) return;
    if (ok === this.last) this.streak = 0;
    else if (++this.streak >= STT_HEALTH_CONFIRM) {
      this.last = ok;
      this.streak = 0;
      try { this.o.send({ type: "stt_health", ok }); } catch { /* a closed channel: the parent is gone */ }
    }
    this.arm();
  }
}
