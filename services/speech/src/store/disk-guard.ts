import { statfsSync } from "node:fs";

/** What the guard needs from `statfs`: node returns numbers unless asked for bigint, so both are accepted. */
export type StatfsResult = { bavail: bigint | number; bsize: bigint | number };
export type StatfsFn = (p: string) => StatfsResult;
export type DiskCheck = { ok: true } | { ok: false; volume: "audio" | "sessions" };

const MIB = 1024n * 1024n;
const NAMES = ["audio", "sessions"] as const;

/** Exact BigInt of a non-negative integer, or null (negative, fractional, NaN, infinite, wrong type). */
function toBig(x: bigint | number): bigint | null {
  if (typeof x === "bigint") return x >= 0n ? x : null;
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null;
}

/**
 * US-0073 (voice A2a, Task 5): refuses to record when either the audio volume or the sessions volume would drop to the floor.
 * Fails closed (a throwing `statfs` or odd numbers mean "not ok"). The result names the volume only: never a path. No logging.
 */
export class DiskGuard {
  private readonly volumes: readonly [string, string];
  private readonly floor: bigint;
  private readonly statfs: StatfsFn;

  constructor(o: { volumes: string[]; minFreeMb: number; statfs?: StatfsFn }) {
    if (!Number.isInteger(o.minFreeMb) || o.minFreeMb <= 0) throw new Error("disk guard: minFreeMb must be a positive integer");
    if (!Array.isArray(o.volumes) || o.volumes.length !== 2 || !o.volumes.every((v) => typeof v === "string" && v.length > 0)) {
      throw new Error("disk guard: volumes must be exactly two non-empty strings");
    }
    this.volumes = [o.volumes[0]!, o.volumes[1]!];
    this.floor = BigInt(o.minFreeMb) * MIB;
    this.statfs = o.statfs ?? ((p) => statfsSync(p));
  }

  /** Free space on each volume must be strictly greater than the floor plus `nextBytes`. Reports the first failing volume. */
  check(nextBytes: number): DiskCheck {
    const next = toBig(nextBytes);
    if (next === null) return { ok: false, volume: "audio" };
    const need = this.floor + next;
    for (let i = 0; i < 2; i++) {
      try {
        const s = this.statfs(this.volumes[i]!);
        const avail = toBig(s.bavail);
        const size = toBig(s.bsize);
        if (avail === null || size === null || avail * size <= need) return { ok: false, volume: NAMES[i]! };
      } catch {
        return { ok: false, volume: NAMES[i]! };
      }
    }
    return { ok: true };
  }
}
