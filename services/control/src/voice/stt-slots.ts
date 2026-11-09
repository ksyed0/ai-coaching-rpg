import { DEFAULT_STT_COLD_TIMEOUT_MS } from "@acr/adapters";
import type { SetTimer } from "../supervisor.js";

/** STT_GLOBAL_IN_FLIGHT: speech-to-text calls at once across EVERY session of this control service (one Whisper server, one GPU). */
export const STT_GLOBAL_IN_FLIGHT = 2;
/** A granted slot is a lease of the cold deadline plus this margin: no healthy call can hold one longer. */
export const STT_LEASE_MARGIN_MS = 5000;
/** At most this many requests of one owner wait; beyond it a request is ignored (the worker's own segment deadline fails it). */
export const MAX_WAITING_PER_OWNER = 64;
/** The worker's range for STT_COLD_TIMEOUT_MS (services/speech/src/config.ts COLD_RANGE): control parses it the same way. */
const COLD_RANGE = [1000, 300_000] as const;

/**
 * The lease: STT_COLD_TIMEOUT_MS (the worker's range and default; a value the worker would refuse gives the default here, and the
 * worker then refuses to start anyway) plus STT_LEASE_MARGIN_MS.
 */
export function sttLeaseMs(env: NodeJS.ProcessEnv): number {
  const raw = env.STT_COLD_TIMEOUT_MS;
  const n = raw !== undefined && /^[0-9]{1,7}$/.test(raw) ? Number(raw) : Number.NaN;
  const cold = Number.isSafeInteger(n) && n >= COLD_RANGE[0] && n <= COLD_RANGE[1] ? n : DEFAULT_STT_COLD_TIMEOUT_MS;
  return cold + STT_LEASE_MARGIN_MS;
}

type Waiter = { key: string; owner: string; grant: () => void };

/**
 * US-0071 (EPIC-0003 voice A1b, Task 6, AC-0409, R11): ONE speech-to-text budget for every session, held by control. A worker asks for
 * a slot (`stt_slot_request`) around each inner call and gives it back (`stt_slot_release`); control grants at most `max` at once, in
 * FIFO order across owners (an owner is a session id). Slots are keyed by owner and slot id (two workers may pick the same id).
 *  - A grant is a LEASE of `leaseMs`: when it runs out the slot is reclaimed, the next waiter is granted, a fixed sentence is logged
 *    (the owner's session id only, never a slot id) and `onExpired(owner)` is called (VoiceHost kills that worker; its restart follows).
 *  - A release of an unknown or expired slot is a no-op; a request already held or waiting is ignored; at most MAX_WAITING_PER_OWNER
 *    wait per owner. `releaseAll(owner)` (a worker exited, a session was forgotten) frees its slots and drops its waiters at once.
 * Documented limit (R11): the cold rule is per worker but the server is shared, so one session's cold call (up to STT_COLD_TIMEOUT_MS,
 * 30 s) holds a global slot; while two cold calls run, every other session's warm segments (5 s deadline) can time out and their
 * speakers get `stt_failed` notices. Accepted for the pilot (one session at a time is the expected case).
 */
export class SttSlots {
  private readonly held = new Map<string, { owner: string; cancel: () => void }>();
  private readonly queue: Waiter[] = [];

  constructor(private readonly o: {
    max: number; leaseMs: number; setTimer: SetTimer; onExpired: (owner: string) => void; log: (m: string) => void;
  }) {}

  get inUse(): number { return this.held.size; }
  get waiting(): number { return this.queue.length; }

  request(owner: string, slot: string, grant: () => void): void {
    const key = `${owner}\n${slot}`;
    if (this.held.has(key) || this.queue.some((w) => w.key === key)) return;
    if (this.queue.filter((w) => w.owner === owner).length >= MAX_WAITING_PER_OWNER) return;
    this.queue.push({ key, owner, grant });
    this.pump();
  }

  release(owner: string, slot: string): void {
    const key = `${owner}\n${slot}`;
    const h = this.held.get(key);
    if (h) { this.held.delete(key); h.cancel(); this.pump(); return; }
    const i = this.queue.findIndex((w) => w.key === key);
    if (i >= 0) this.queue.splice(i, 1);
  }

  releaseAll(owner: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.owner === owner) this.queue.splice(i, 1);
    for (const [key, h] of [...this.held]) if (h.owner === owner) { this.held.delete(key); h.cancel(); }
    this.pump();
  }

  private pump(): void {
    while (this.held.size < this.o.max && this.queue.length > 0) {
      const w = this.queue.shift()!;
      const lease = { owner: w.owner, cancel: () => {} };
      this.held.set(w.key, lease);
      lease.cancel = this.o.setTimer(() => this.expire(w.key, lease), this.o.leaseMs);
      try { w.grant(); } catch { /* the worker's channel is going away: its exit releases the slot */ }
    }
  }

  private expire(key: string, lease: { owner: string }): void {
    if (this.held.get(key) !== lease) return; // released (or re-granted) meanwhile
    this.held.delete(key);
    this.o.log(`session ${lease.owner} speech slot lease expired (timeout)`);
    this.pump();
    try { this.o.onExpired(lease.owner); } catch { /* VoiceHost's handler never throws; nothing more to do here */ }
  }
}
