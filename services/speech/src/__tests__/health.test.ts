import { describe, expect, it } from "vitest";
import type { SpeechToText } from "@acr/adapters";
import { HealthPoller, STT_HEALTH_CONFIRM, STT_HEALTH_POLL_MS } from "../health.js";
import type { WorkerMessage } from "../protocol.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 9, AC-0411): the worker polls the speech-to-text server's health every 5 s and reports a CHANGE
 * only after STT_HEALTH_CONFIRM consecutive polls agree on it (batch 2 review F9: a flapping server must not flood the pages with
 * voice_unavailable / voice_available pairs). Manual timers and scripted answers: no real time.
 */
type T = { fn: () => void; ms: number; cancelled: boolean };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness(answers: (boolean | "hang" | "throw")[], initial = true) {
  const timers: T[] = [];
  const sent: WorkerMessage[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const stt = {
    health: () => {
      const a = answers[calls++] ?? true;
      if (a === "hang") return new Promise<boolean>((r) => { release = () => r(true); });
      if (a === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve(a);
    },
  } as unknown as SpeechToText;
  const p = new HealthPoller({ stt, initial, send: (m) => sent.push(m), setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } });
  const tick = async () => {
    const live = timers.filter((t) => !t.cancelled);
    expect(live).toHaveLength(1);
    live[0]!.cancelled = true; live[0]!.fn();
    await settle();
  };
  return { p, timers, sent, tick, calls: () => calls, release: () => release?.() };
}

describe("HealthPoller (US-0071, A1b Task 9)", () => {
  it("the constants: every 5000 ms, two agreeing polls before a change", () => {
    expect(STT_HEALTH_POLL_MS).toBe(5000);
    expect(STT_HEALTH_CONFIRM).toBe(2);
  });

  it("polls every 5000 ms", async () => {
    const h = harness([true, true, true]);
    h.p.start();
    expect(h.timers.map((t) => t.ms)).toEqual([5000]);
    expect(h.calls()).toBe(0);
    await h.tick(); await h.tick(); await h.tick();
    expect(h.calls()).toBe(3);
    expect(h.timers.every((t) => t.ms === STT_HEALTH_POLL_MS)).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("true, true, false, false, true, true sends false then true only", async () => {
    const h = harness([true, true, false, false, true, true]);
    h.p.start();
    for (let i = 0; i < 6; i++) await h.tick();
    expect(h.sent).toEqual([{ type: "stt_health", ok: false }, { type: "stt_health", ok: true }]);
  });

  it("a single different poll between agreeing ones sends nothing (hysteresis)", async () => {
    const h = harness([false, true, false, true, false, true, true]);
    h.p.start();
    for (let i = 0; i < 7; i++) await h.tick();
    expect(h.sent).toEqual([]);
  });

  it("initial false (a failed warm-up) then two healthy polls send ok true", async () => {
    const h = harness([true, true], false);
    h.p.start();
    await h.tick();
    expect(h.sent).toEqual([]);
    await h.tick();
    expect(h.sent).toEqual([{ type: "stt_health", ok: true }]);
  });

  it("a health call that throws counts as unhealthy", async () => {
    const h = harness(["throw", "throw"]);
    h.p.start();
    await h.tick(); await h.tick();
    expect(h.sent).toEqual([{ type: "stt_health", ok: false }]);
  });

  it("a health call that hangs delays the next poll instead of stacking", async () => {
    const h = harness(["hang", true]);
    h.p.start();
    await h.tick();
    expect(h.timers.filter((t) => !t.cancelled)).toEqual([]); // nothing armed while the call is open
    expect(h.calls()).toBe(1);
    h.release();
    await settle();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  it("stop cancels the timer, and a call that settles after stop sends nothing and arms nothing", async () => {
    const h = harness([false, "hang"]);
    h.p.start();
    await h.tick();
    await h.tick(); // the second (hanging) call is open
    h.p.stop();
    h.release();
    await settle();
    expect(h.timers.filter((t) => !t.cancelled)).toEqual([]);
    expect(h.sent).toEqual([]);
    const g = harness([]);
    g.p.start();
    g.p.stop();
    expect(g.timers.filter((t) => !t.cancelled)).toEqual([]);
  });

  it("start twice arms one poll", () => {
    const h = harness([]);
    h.p.start(); h.p.start();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });
});
