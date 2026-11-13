import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STT_COLD_TIMEOUT_MS } from "@acr/adapters";
import { MAX_WAITING_PER_OWNER, STT_GLOBAL_IN_FLIGHT, STT_LEASE_MARGIN_MS, SttSlots, sttLeaseMs } from "../../voice/stt-slots.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 6, AC-0409): ONE speech-to-text budget across every session, held by control. Manual timers: a
 * lease expires only when the test fires its timer (no real time).
 */
type T = { fn: () => void; ms: number; cancelled: boolean };
let timers: T[], logs: string[], expired: string[], granted: string[];
const LEASE = 35_000;
const make = (max = STT_GLOBAL_IN_FLIGHT) => new SttSlots({
  max, leaseMs: LEASE, log: (m) => logs.push(m), onExpired: (owner) => expired.push(owner),
  setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
});
const ask = (s: SttSlots, owner: string, slot: string) => s.request(owner, slot, () => granted.push(`${owner}/${slot}`));
const fireLeases = () => { for (const t of timers.filter((x) => x.ms === LEASE && !x.cancelled)) { t.cancelled = true; t.fn(); } };
const A = "a".repeat(32);
const B = "b".repeat(32);

beforeEach(() => { timers = []; logs = []; expired = []; granted = []; });

describe("SttSlots (US-0071, A1b Task 6): one leased speech-to-text budget across sessions", () => {
  it("the constants: a global budget of 2, a lease of STT_COLD_TIMEOUT_MS + 5 s parsed with the worker's range and default", () => {
    expect(STT_GLOBAL_IN_FLIGHT).toBe(2);
    expect(STT_LEASE_MARGIN_MS).toBe(5000);
    expect(MAX_WAITING_PER_OWNER).toBe(64);
    expect(sttLeaseMs({})).toBe(DEFAULT_STT_COLD_TIMEOUT_MS + 5000);
    expect(sttLeaseMs({ STT_COLD_TIMEOUT_MS: "60000" })).toBe(65_000);
    for (const bad of ["999", "300001", "abc", "1e4", "-5", ""]) expect(sttLeaseMs({ STT_COLD_TIMEOUT_MS: bad })).toBe(DEFAULT_STT_COLD_TIMEOUT_MS + 5000);
  });

  it("two sessions each asking twice get two grants in total, the third waits", () => {
    const s = make();
    ask(s, A, "1111111111111111"); ask(s, A, "2222222222222222");
    ask(s, B, "3333333333333333"); ask(s, B, "4444444444444444");
    expect(granted).toEqual([`${A}/1111111111111111`, `${A}/2222222222222222`]);
    expect(s.inUse).toBe(2);
    expect(s.waiting).toBe(2);
  });

  it("FIFO across sessions, and a release grants the next waiter", () => {
    const s = make();
    ask(s, A, "1111111111111111"); ask(s, B, "2222222222222222");
    ask(s, A, "3333333333333333"); ask(s, B, "4444444444444444"); ask(s, A, "5555555555555555");
    s.release(A, "1111111111111111");
    expect(granted.at(-1)).toBe(`${A}/3333333333333333`);
    s.release(B, "2222222222222222");
    expect(granted.at(-1)).toBe(`${B}/4444444444444444`);
    s.release(A, "3333333333333333");
    expect(granted).toEqual([`${A}/1111111111111111`, `${B}/2222222222222222`, `${A}/3333333333333333`, `${B}/4444444444444444`, `${A}/5555555555555555`]);
    // A released slot's lease timer is cancelled: it never fires an expiry later.
    expect(timers.filter((t) => t.ms === LEASE && !t.cancelled)).toHaveLength(2);
  });

  it("the same slot id from two owners is two slots", () => {
    const s = make();
    ask(s, A, "1111111111111111"); ask(s, B, "1111111111111111");
    expect(granted).toEqual([`${A}/1111111111111111`, `${B}/1111111111111111`]);
    s.release(A, "1111111111111111");
    expect(s.inUse).toBe(1); // B's slot is untouched
  });

  it("releaseAll of a dead worker frees its slots and drops its waiters", () => {
    const s = make();
    ask(s, A, "1111111111111111"); ask(s, A, "2222222222222222"); ask(s, A, "3333333333333333"); ask(s, B, "4444444444444444");
    s.releaseAll(A);
    expect(granted.at(-1)).toBe(`${B}/4444444444444444`);
    expect(granted).not.toContain(`${A}/3333333333333333`);
    expect(s.inUse).toBe(1);
    expect(s.waiting).toBe(0);
    expect(timers.filter((t) => t.ms === LEASE && !t.cancelled)).toHaveLength(1);
  });

  it("a duplicate request (held or waiting) is ignored", () => {
    const s = make(1);
    ask(s, A, "1111111111111111"); ask(s, A, "1111111111111111");
    ask(s, A, "2222222222222222"); ask(s, A, "2222222222222222");
    expect(granted).toEqual([`${A}/1111111111111111`]);
    expect(s.waiting).toBe(1);
  });

  it("the 65th waiting request of one owner is ignored; another owner may still wait", () => {
    const s = make(1);
    ask(s, B, "ffffffffffffffff"); // holds the only slot
    for (let i = 0; i < MAX_WAITING_PER_OWNER + 1; i++) ask(s, A, i.toString(16).padStart(16, "0"));
    expect(s.waiting).toBe(MAX_WAITING_PER_OWNER);
    ask(s, B, "eeeeeeeeeeeeeeee");
    expect(s.waiting).toBe(MAX_WAITING_PER_OWNER + 1);
  });

  it("an expired lease is reclaimed and the next waiter granted", () => {
    const s = make(1);
    ask(s, A, "1111111111111111"); ask(s, B, "2222222222222222");
    expect(granted).toEqual([`${A}/1111111111111111`]);
    fireLeases();
    expect(granted).toEqual([`${A}/1111111111111111`, `${B}/2222222222222222`]);
    expect(s.inUse).toBe(1);
    expect(s.waiting).toBe(0);
  });

  it("an expired lease calls onExpired with the owner and logs a fixed sentence (no slot id)", () => {
    const s = make(1);
    ask(s, A, "1111111111111111");
    fireLeases();
    expect(expired).toEqual([A]);
    expect(logs).toEqual([`session ${A} speech slot lease expired (timeout)`]);
    expect(logs.join("\n")).not.toContain("1111111111111111");
  });

  it("a late release of an expired slot is a no-op and grants nothing twice", () => {
    const s = make(1);
    ask(s, A, "1111111111111111"); ask(s, B, "2222222222222222"); ask(s, B, "3333333333333333");
    fireLeases(); // A's lease is reclaimed: B's first slot is granted
    s.release(A, "1111111111111111"); // the stuck worker's release arrives late
    expect(granted).toEqual([`${A}/1111111111111111`, `${B}/2222222222222222`]);
    expect(s.inUse).toBe(1);
    expect(s.waiting).toBe(1);
    s.release(A, "9999999999999999"); // never asked: nothing
    expect(s.inUse).toBe(1);
  });

  it("a release of a waiting request withdraws it", () => {
    const s = make(1);
    ask(s, A, "1111111111111111"); ask(s, B, "2222222222222222");
    s.release(B, "2222222222222222");
    s.release(A, "1111111111111111");
    expect(granted).toEqual([`${A}/1111111111111111`]);
    expect(s.inUse).toBe(0);
  });

  it("a grant callback that throws does not break the budget", () => {
    const s = make(1);
    s.request(A, "1111111111111111", () => { throw new Error("channel closed"); });
    ask(s, B, "2222222222222222");
    expect(s.inUse).toBe(1);
    s.release(A, "1111111111111111");
    expect(granted).toEqual([`${B}/2222222222222222`]);
    expect(logs.join("\n")).not.toContain("channel closed");
  });
});
