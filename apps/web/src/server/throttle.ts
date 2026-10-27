// Failed-join throttle keyed by (address, role). Bounded: the role id may be attacker-chosen, so it is capped and folded, and the
// number of tracked keys is capped with oldest-first eviction.

const MAX_ROLE_CHARS = 128;
const MAX_ADDRESS_CHARS = 64;
const DEFAULT_MAX_KEYS = 10_000;

type Entry = { count: number; windowStart: number; blockedUntil: number };

// Fold anything outside a plain id alphabet so no value can contain the key separator or control characters.
const fold = (s: string, max: number): string => s.slice(0, max).replace(/[^A-Za-z0-9_.:*-]/g, "_");

export class JoinThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  constructor(private readonly o: { max: number; windowMs: number; blockMs: number; now: () => number; maxKeys?: number }) {
    this.maxKeys = o.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  get size(): number { return this.entries.size; }

  private key(ip: string, role: string): string { return `${fold(ip, MAX_ADDRESS_CHARS)}|${fold(role, MAX_ROLE_CHARS)}`; }

  private live(e: Entry, now: number): boolean { return e.blockedUntil > now || e.windowStart + this.o.windowMs > now; }

  fail(ip: string, role: string): void {
    const now = this.o.now();
    const k = this.key(ip, role);
    let e = this.entries.get(k);
    if (e && !this.live(e, now)) { this.entries.delete(k); e = undefined; }
    // A failure while blocked is not counted: it must not extend the block.
    if (e && e.blockedUntil > now) return;
    if (!e) {
      if (this.entries.size >= this.maxKeys) this.makeRoom(now);
      e = { count: 0, windowStart: now, blockedUntil: 0 };
      this.entries.set(k, e);
    }
    e.count += 1;
    if (e.count > this.o.max) e.blockedUntil = now + this.o.blockMs;
  }

  blockedForMs(ip: string, role: string): number {
    const e = this.entries.get(this.key(ip, role));
    if (!e) return 0;
    return Math.max(0, e.blockedUntil - this.o.now());
  }

  private makeRoom(now: number): void {
    for (const [k, e] of this.entries) if (!this.live(e, now)) this.entries.delete(k);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
