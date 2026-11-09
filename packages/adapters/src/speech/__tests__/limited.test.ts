import { describe, expect, it } from "vitest";
import { DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_IDLE_COLD_MS, LimitedSpeechToText } from "../limited.js";
import { FakeSpeechToText } from "../fake.js";
import { speechToTextContract, type ContractControl } from "../contract.js";
import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError } from "../errors.js";
import type { SpeechSegment, SpeechToText, Transcript } from "../types.js";

// US-0070 (Task 13, AC-0399, AC-0402): deadlines, bounded retries, the in-flight cap and the cold-start deadline (owner preference
// 2026-11-08: a local model may need time to load after idling). Everything runs on an injected clock, injected timers and recorded
// sleeps: no real time passes in any test.

/** An inner SpeechToText whose every call waits for the test to settle it; an abort of its signal rejects it as a timeout. */
class HeldInner implements SpeechToText {
  readonly calls: { seg: SpeechSegment; signal?: AbortSignal; ok(t?: Partial<Transcript>): void; fail(e: Error): void }[] = [];
  warmUps = 0;
  warm: "ok" | Error = "ok";
  transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new SpeechTimeoutError()); return; }
      signal?.addEventListener("abort", () => reject(new SpeechTimeoutError()), { once: true });
      this.calls.push({ seg, ...(signal ? { signal } : {}), ok: (t) => resolve({ text: seg.id, durationMs: 1, ...t }), fail: reject });
    });
  }
  async health() { return true; }
  async warmUp() { this.warmUps += 1; if (this.warm !== "ok") throw this.warm; }
}

function rig(o: { maxInFlight?: number; maxRetries?: number; queueAlertAt?: number } = {}) {
  let t = 1_000;
  const timers: { fn: () => void; ms: number; at: number; cancelled: boolean; fired: boolean }[] = [];
  const sleeps: number[] = [];
  const sleepWaits: { ms: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const alerts: number[] = [];
  const inner = new HeldInner();
  const lim = new LimitedSpeechToText(inner, {
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, ms, at: t + ms, cancelled: false, fired: false }; timers.push(x); return () => { x.cancelled = true; }; },
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      sleeps.push(ms);
      const w = { ms, resolve, reject };
      sleepWaits.push(w);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    ...o, onQueueAlert: () => alerts.push(t),
  });
  const live = () => timers.filter((x) => !x.cancelled && !x.fired);
  const fireDue = () => { for (const x of live()) if (x.at <= t) { x.fired = true; x.fn(); } };
  return {
    inner, lim, timers, live, sleeps, sleepWaits, alerts,
    get now() { return t; },
    advance(ms: number) { t += ms; fireDue(); },
    /** The limiter is warm: one warm-up answered at the current time. */
    async warm() { await lim.warmUp(); },
  };
}
const seg = (id: string, deadline: number): SpeechSegment => ({ id, pcm: new Int16Array(16), sampleRate: 16000, deadline });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const outcome = (p: Promise<Transcript>) => p.then((x) => x.text, (e: Error) => e.name);

describe("LimitedSpeechToText (US-0070)", () => {
  it("three calls with maxInFlight 2 start two, then the third after one finishes", async () => {
    const r = rig();
    await r.warm();
    const ps = ["a", "b", "c"].map((id) => outcome(r.lim.transcribe(seg(id, r.now + 5000))));
    await tick();
    expect(r.inner.calls.map((c) => c.seg.id)).toEqual(["a", "b"]);
    expect([r.lim.inFlight, r.lim.queued]).toEqual([2, 1]);
    r.inner.calls[1]!.ok();
    await tick();
    expect(r.inner.calls.map((c) => c.seg.id)).toEqual(["a", "b", "c"]);
    r.inner.calls[0]!.ok(); r.inner.calls[2]!.ok();
    expect(await Promise.all(ps)).toEqual(["a", "b", "c"]);
    expect([r.lim.inFlight, r.lim.queued]).toEqual([0, 0]);
  });

  it("a transient failure retries at 150 then 300 and succeeds", async () => {
    const r = rig();
    await r.warm();
    const p = outcome(r.lim.transcribe(seg("a", r.now + 5000)));
    await tick();
    r.inner.calls[0]!.fail(new SpeechUnavailableError());
    await tick();
    expect(r.sleeps).toEqual([150]);
    r.advance(150); r.sleepWaits[0]!.resolve();
    await tick();
    r.inner.calls[1]!.fail(new SpeechUnavailableError());
    await tick();
    expect(r.sleeps).toEqual([150, 300]);
    r.advance(300); r.sleepWaits[1]!.resolve();
    await tick();
    r.inner.calls[2]!.ok();
    expect(await p).toBe("a");
    expect(r.inner.calls).toHaveLength(3);
  });

  it("retries stop at 2: the third failure is final", async () => {
    const r = rig();
    await r.warm();
    const p = outcome(r.lim.transcribe(seg("a", r.now + 5000)));
    for (let i = 0; i < 3; i++) {
      await tick();
      r.inner.calls[i]!.fail(new SpeechUnavailableError());
      await tick();
      if (i < 2) { r.advance(r.sleeps[i]!); r.sleepWaits[i]!.resolve(); }
    }
    expect(await p).toBe("SpeechUnavailableError");
    expect(r.inner.calls).toHaveLength(3);
    expect(r.sleeps).toEqual([150, 300]);
  });

  it("Refused is not retried; an error of another type counts as Unavailable", async () => {
    const r = rig({ maxRetries: 0 });
    await r.warm();
    const p = outcome(r.lim.transcribe(seg("a", r.now + 5000)));
    await tick();
    r.inner.calls[0]!.fail(new SpeechRefusedError());
    expect(await p).toBe("SpeechRefusedError");
    expect(r.sleeps).toEqual([]);
    const q = outcome(r.lim.transcribe(seg("b", r.now + 5000)));
    await tick();
    r.inner.calls[1]!.fail(new TypeError("odd"));
    expect(await q).toBe("SpeechUnavailableError");
  });

  it("a retry that would end after the deadline is not attempted (deadline 200 ms after start, first failure at 100: no 150 ms sleep)", async () => {
    const r = rig();
    await r.warm();
    const p = outcome(r.lim.transcribe(seg("a", r.now + 200)));
    await tick();
    r.advance(100);
    r.inner.calls[0]!.fail(new SpeechUnavailableError());
    expect(await p).toBe("SpeechUnavailableError");
    expect(r.sleeps).toEqual([]);
    expect(r.inner.calls).toHaveLength(1);
  });

  it("a queued item past its deadline fails Timeout without calling inner", async () => {
    const r = rig({ maxInFlight: 1 });
    await r.warm();
    const a = outcome(r.lim.transcribe(seg("a", r.now + 5000)));
    const b = outcome(r.lim.transcribe(seg("b", r.now + 50)));
    await tick();
    expect(r.lim.queued).toBe(1);
    r.advance(50);
    expect(await b).toBe("SpeechTimeoutError");
    expect(r.lim.queued).toBe(0);
    r.inner.calls[0]!.ok();
    expect(await a).toBe("a");
    expect(r.inner.calls.map((c) => c.seg.id)).toEqual(["a"]);
  });

  it("the deadline aborts an in-flight call, and its slot frees only once the inner call has settled", async () => {
    const r = rig({ maxInFlight: 1 });
    await r.warm();
    const a = outcome(r.lim.transcribe(seg("a", r.now + 300)));
    const b = outcome(r.lim.transcribe(seg("b", r.now + 5000)));
    await tick();
    r.advance(300);
    expect(r.inner.calls[0]!.signal?.aborted).toBe(true);
    expect(await a).toBe("SpeechTimeoutError");
    await tick();
    expect(r.inner.calls.map((c) => c.seg.id)).toEqual(["a", "b"]);
    r.inner.calls[1]!.ok();
    expect(await b).toBe("b");
  });

  it("a deadline during the wait between retries fails Timeout", async () => {
    const r = rig();
    await r.warm();
    const p = outcome(r.lim.transcribe(seg("a", r.now + 1000)));
    await tick();
    r.inner.calls[0]!.fail(new SpeechUnavailableError());
    await tick();
    expect(r.sleeps).toEqual([150]);
    r.advance(1000);
    expect(await p).toBe("SpeechTimeoutError");
  });

  it("the caller's own abort fails a queued or a running item with Timeout", async () => {
    const r = rig({ maxInFlight: 1 });
    await r.warm();
    const ac1 = new AbortController(); const ac2 = new AbortController();
    const a = outcome(r.lim.transcribe(seg("a", r.now + 5000), ac1.signal));
    const b = outcome(r.lim.transcribe(seg("b", r.now + 5000), ac2.signal));
    await tick();
    ac2.abort();
    expect(await b).toBe("SpeechTimeoutError");
    ac1.abort();
    expect(await a).toBe("SpeechTimeoutError");
    const done = new AbortController(); done.abort();
    expect(await outcome(r.lim.transcribe(seg("c", r.now + 5000), done.signal))).toBe("SpeechTimeoutError");
    expect(r.inner.calls.map((c) => c.seg.id)).toEqual(["a"]);
  });

  it("onQueueAlert fires once at 16, and again only after the queue fell below and reached it again", async () => {
    const r = rig({ maxInFlight: 1 });
    await r.warm();
    const ps = Array.from({ length: 18 }, (_, i) => outcome(r.lim.transcribe(seg(`s${i}`, r.now + 60_000))));
    await tick();
    expect(r.lim.queued).toBe(17);
    expect(r.alerts).toHaveLength(1);
    for (let i = 0; i < 3; i++) { r.inner.calls[i]!.ok(); await tick(); }
    expect(r.lim.queued).toBe(14);
    ps.push(outcome(r.lim.transcribe(seg("x1", r.now + 60_000))), outcome(r.lim.transcribe(seg("x2", r.now + 60_000))));
    await tick();
    expect(r.alerts).toHaveLength(2);
    for (let i = 3; i < 20; i++) { r.inner.calls[i]!.ok(); await tick(); }
    expect((await Promise.all(ps)).length).toBe(20);
  });

  describe("cold start (STT_COLD_TIMEOUT_MS, STT_IDLE_COLD_MS)", () => {
    const armedFor = (r: ReturnType<typeof rig>, id: string) => {
      const before = r.timers.length;
      return { p: outcome(r.lim.transcribe(seg(id, r.now + 5000))), ms: () => r.timers[before]!.ms };
    };

    it("the first call since the start gets the cold deadline; a warm call keeps the tight deadline", async () => {
      const r = rig();
      const first = armedFor(r, "a");
      expect(first.ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS);
      await tick();
      r.inner.calls[0]!.ok();
      expect(await first.p).toBe("a");
      const warm = armedFor(r, "b");
      expect(warm.ms()).toBe(5000);
      await tick();
      r.inner.calls[1]!.ok();
      await warm.p;
    });

    it("the first call after idle gets the cold deadline", async () => {
      const r = rig();
      await r.warm();
      r.advance(DEFAULT_STT_IDLE_COLD_MS - 1);
      const stillWarm = armedFor(r, "a");
      expect(stillWarm.ms()).toBe(5000);
      await tick(); r.inner.calls[0]!.ok(); await stillWarm.p;
      r.advance(DEFAULT_STT_IDLE_COLD_MS);
      const cold = armedFor(r, "b");
      expect(cold.ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS);
      await tick(); r.inner.calls[1]!.ok(); await cold.p;
    });

    it("a call made while a cold call is still loading the model gets the cold deadline too; after an answer it is warm", async () => {
      const r = rig();
      const a = armedFor(r, "a");
      const b = armedFor(r, "b");
      expect([a.ms(), b.ms()]).toEqual([DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_COLD_TIMEOUT_MS]);
      await tick();
      r.inner.calls[0]!.ok(); r.inner.calls[1]!.ok();
      await Promise.all([a.p, b.p]);
      expect(armedFor(r, "c").ms()).toBe(5000);
      await tick(); r.inner.calls[2]!.ok();
    });

    it("a segment deadline later than the cold one is kept", async () => {
      const r = rig();
      const before = r.timers.length;
      void outcome(r.lim.transcribe(seg("a", r.now + 90_000)));
      expect(r.timers[before]!.ms).toBe(90_000);
      await tick(); r.inner.calls[0]!.ok();
    });

    it("a cold call that exceeds the cold deadline still fails with SpeechTimeoutError", async () => {
      const r = rig();
      const a = armedFor(r, "a");
      await tick();
      r.advance(5000);
      expect(r.inner.calls[0]!.signal?.aborted).toBe(false); // the tight deadline does not apply while cold
      r.advance(DEFAULT_STT_COLD_TIMEOUT_MS - 5000);
      expect(r.inner.calls[0]!.signal?.aborted).toBe(true);
      expect(await a.p).toBe("SpeechTimeoutError");
    });

    it("a server that only fails (unavailable) keeps the limiter cold; a refusal is an answer and makes it warm", async () => {
      const r = rig({ maxRetries: 0 });
      const a = armedFor(r, "a");
      await tick(); r.inner.calls[0]!.fail(new SpeechUnavailableError());
      await a.p;
      const b = armedFor(r, "b");
      expect(b.ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS);
      await tick(); r.inner.calls[1]!.fail(new SpeechRefusedError());
      await b.p;
      expect(armedFor(r, "c").ms()).toBe(5000);
      await tick(); r.inner.calls[2]!.ok();
    });

    it("warmUp runs under the cold deadline, makes the limiter warm, and a failed warm-up leaves it cold", async () => {
      const r = rig();
      r.inner.warm = new SpeechUnavailableError();
      await expect(r.lim.warmUp()).rejects.toBeInstanceOf(SpeechUnavailableError);
      expect(armedFor(r, "a").ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS);
      await tick(); r.inner.calls[0]!.ok();
      r.inner.warm = "ok";
      await r.lim.warmUp();
      expect(r.inner.warmUps).toBe(2);
      expect(armedFor(r, "b").ms()).toBe(5000);
      await tick(); r.inner.calls[1]!.ok();
    });

    // US-0071 (A1b Task 9): the worker polls health() every 5 s. A poll is not a call: it must neither warm a cold limiter (a model
    // that has not loaded yet still gets the cold deadline) nor keep a warm one warm past STT_IDLE_COLD_MS (the model unloads anyway).
    it("health polls never change the warm or cold state", async () => {
      const r = rig();
      r.inner.warm = new SpeechUnavailableError(); // the warm-up got no answer (activity, but cold)
      await expect(r.lim.warmUp()).rejects.toBeInstanceOf(SpeechUnavailableError);
      for (let i = 0; i < 3; i++) { expect(await r.lim.health()).toBe(true); r.advance(5000); }
      const first = armedFor(r, "a");
      expect(first.ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS); // still cold: no answer yet, whatever health said
      await tick(); r.inner.calls[0]!.ok(); await first.p;
      for (let waited = 0; waited < DEFAULT_STT_IDLE_COLD_MS; waited += 5000) { await r.lim.health(); r.advance(5000); }
      const idle = armedFor(r, "b");
      expect(idle.ms()).toBe(DEFAULT_STT_COLD_TIMEOUT_MS); // idle for STT_IDLE_COLD_MS despite the polls: cold again
      await tick(); r.inner.calls[1]!.ok(); await idle.p;
    });
  });

  it("a deadline beyond the largest timer delay is clamped, never overflowing into an instant fire", async () => {
    const r = rig();
    await r.warm();
    const before = r.timers.length;
    void outcome(r.lim.transcribe(seg("a", Number.MAX_SAFE_INTEGER)));
    expect(r.timers[before]!.ms).toBe(2_147_483_647);
    await tick(); r.inner.calls[0]!.ok();
  });

  it("health passes through", async () => {
    const r = rig();
    expect(await r.lim.health()).toBe(true);
  });
});

speechToTextContract("limited(fake)", async () => {
  let answer: Transcript = { text: "ok", durationMs: 0 };
  let failure: "unavailable" | "refused" | "hang" | null = null;
  let hanging: () => void = () => {};
  let hangSeen = Promise.resolve();
  const inner = new FakeSpeechToText({
    healthy: () => failure !== "unavailable",
    script: () => {
      if (failure === "unavailable") return new SpeechUnavailableError();
      if (failure === "refused") return new SpeechRefusedError();
      if (failure === "hang") { hanging(); return new Promise<never>(() => {}); }
      return answer;
    },
  });
  // Retries wait on a sleep that resolves at once; deadline timers never fire on their own (no real time).
  const stt = new LimitedSpeechToText(inner, { now: () => 0, sleep: async () => {}, setTimer: () => () => {} });
  const control: ContractControl = {
    answer(text, extra) { failure = null; answer = { text, durationMs: 0, ...extra }; },
    fail(kind) { failure = kind; if (kind === "hang") hangSeen = new Promise((r) => { hanging = r; }); },
    whenHanging: () => hangSeen,
  };
  return { stt, control, close: async () => {} };
});
