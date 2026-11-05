import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { MAX_RETAINED_EVENTS, RecentEvents } from "../recent-events.js";

const ev = (seq: number): SessionEvent => ({ seq, ts: seq, sessionId: "s", type: "facilitator.alert", level: "info", message: `m${seq}` });
const seqs = (it: Iterable<SessionEvent>) => [...it].map((e) => e.seq);

describe("RecentEvents (US-0013): the bounded window of recent events a rejoin is replayed from", () => {
  it("test_recent_events_empty_window_has_head_zero_and_replays_nothing", () => {
    const r = new RecentEvents(4);
    expect(r.head).toBe(0);
    expect(r.size).toBe(0);
    expect(r.covers(0)).toBe(true);
    expect(seqs(r.after(0))).toEqual([]);
  });

  it("test_recent_events_after_returns_exactly_the_later_events_in_order", () => {
    const r = new RecentEvents(10);
    for (let i = 1; i <= 6; i++) r.push(ev(i));
    expect(r.head).toBe(6);
    expect(seqs(r.after(0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seqs(r.after(3))).toEqual([4, 5, 6]);
    expect(seqs(r.after(6))).toEqual([]);
  });

  it("test_recent_events_evicts_the_oldest_beyond_its_capacity", () => {
    const r = new RecentEvents(4);
    for (let i = 1; i <= 11; i++) r.push(ev(i));
    expect(r.size).toBe(4);
    expect(r.oldest).toBe(8);
    expect(r.head).toBe(11);
    // A range whose start was evicted is not covered: replaying it would leave a gap.
    expect(r.covers(6)).toBe(false);
    expect(r.covers(7)).toBe(true);
    expect(seqs(r.after(7))).toEqual([8, 9, 10, 11]);
    expect(seqs(r.after(9))).toEqual([10, 11]);
  });

  it("test_recent_events_after_refuses_a_range_it_does_not_cover", () => {
    const r = new RecentEvents(2);
    for (let i = 1; i <= 5; i++) r.push(ev(i));
    expect(() => [...r.after(1)]).toThrow(RangeError);
    expect(() => [...r.after(6)]).toThrow(RangeError);
    expect(() => [...r.after(-1)]).toThrow(RangeError);
    expect(() => [...r.after(2.5)]).toThrow(RangeError);
  });

  it("test_recent_events_a_seq_gap_restarts_the_window_instead_of_lying", () => {
    const r = new RecentEvents(8);
    r.push(ev(1)); r.push(ev(2));
    r.push(ev(5)); // never happens in the engine; the window must not claim to cover 3 and 4
    expect(r.oldest).toBe(5);
    expect(r.covers(2)).toBe(false);
    expect(seqs(r.after(4))).toEqual([5]);
  });

  it("test_recent_events_clear_empties_the_window", () => {
    const r = new RecentEvents(3);
    r.push(ev(1)); r.clear();
    expect(r.size).toBe(0);
    expect(r.head).toBe(0);
    r.push(ev(1));
    expect(seqs(r.after(0))).toEqual([1]);
  });

  it("test_recent_events_capacity_must_be_a_positive_whole_number", () => {
    expect(() => new RecentEvents(0)).toThrow();
    expect(() => new RecentEvents(1.5)).toThrow();
    expect(new RecentEvents().capacity).toBe(MAX_RETAINED_EVENTS);
  });
});
