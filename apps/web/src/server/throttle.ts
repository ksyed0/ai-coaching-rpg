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
  private saturatedUntil = 0;

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
      if (this.entries.size >= this.maxKeys && !this.makeRoom(now)) {
        // Every slot holds an active block. Evicting one would let a flood of new keys lift it, so fail closed instead.
        this.saturatedUntil = now + this.o.blockMs;
        return;
      }
      e = { count: 0, windowStart: now, blockedUntil: 0 };
      this.entries.set(k, e);
    }
    e.count += 1;
    if (e.count > this.o.max) e.blockedUntil = now + this.o.blockMs;
  }

  blockedForMs(ip: string, role: string): number {
    const now = this.o.now();
    const e = this.entries.get(this.key(ip, role));
    // An untracked pair is blocked while the table is saturated by blocks: memory stays bounded and no block can be flushed out.
    if (!e) return Math.max(0, this.saturatedUntil - now);
    return Math.max(0, e.blockedUntil - now);
  }

  /** Evict the oldest entry that is not currently blocked (insertion order); stops at the first one. False when all are blocked. */
  private makeRoom(now: number): boolean {
    for (const [k, e] of this.entries) {
      if (e.blockedUntil <= now) { this.entries.delete(k); return true; }
    }
    return false;
  }
}
