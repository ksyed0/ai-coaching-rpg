import { describe, expect, it } from "vitest";
import type { WorkerMessage } from "../protocol.js";
import { ActivityReporter } from "../activity.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const sent: WorkerMessage[] = [];
  const clock = { t: 1_000_000 };
  const a = new ActivityReporter((m) => { sent.push(m); }, () => clock.t);
  return { sent, clock, a };
}

describe("ActivityReporter (US-0070, overview C3)", () => {
  it("true once per start", () => {
    const { sent, a } = harness();
    a.speechStarted("a");
    a.speechStarted("a");
    a.speechStarted("b");
    expect(sent).toEqual([{ type: "speech_activity", roleId: "a", active: true }, { type: "speech_activity", roleId: "b", active: true }]);
  });

  it("false waits for the outcome and carries silentMs", async () => {
    const { sent, clock, a } = harness();
    a.speechStarted("a");
    const outcome = deferred();
    a.segmentClosed("a", clock.t - 500, outcome.promise);
    await Promise.resolve();
    expect(sent).toHaveLength(1); // the line has not gone out yet: no edge
    clock.t += 150; // transcription took 150 ms
    outcome.resolve();
    await vi_waitFor(() => sent.length === 2);
    expect(sent[1]).toEqual({ type: "speech_activity", roleId: "a", active: false, silentMs: 650 });
  });

  it("a restart before the outcome suppresses the stale false", async () => {
    const { sent, clock, a } = harness();
    a.speechStarted("a");
    const outcome = deferred();
    a.segmentClosed("a", clock.t - 500, outcome.promise);
    a.speechStarted("a"); // still "true" on the wire: nothing new is sent either
    outcome.resolve();
    await outcome.promise;
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([{ type: "speech_activity", roleId: "a", active: true }]);
  });

  it("silentMs is clamped to 0..60000 and whole", async () => {
    const { sent, clock, a } = harness();
    a.speechStarted("a");
    a.segmentClosed("a", clock.t + 10, Promise.resolve());
    await vi_waitFor(() => sent.length === 2);
    expect(sent[1]).toMatchObject({ active: false, silentMs: 0 });
    a.speechStarted("a");
    a.segmentClosed("a", clock.t - 90_000.4, Promise.resolve());
    await vi_waitFor(() => sent.length === 4);
    expect(sent[3]).toMatchObject({ active: false, silentMs: 60_000 });
  });

  it("a closed segment without an earlier start sends nothing (the edge on the wire is already false)", async () => {
    const { sent, clock, a } = harness();
    a.segmentClosed("a", clock.t, Promise.resolve());
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([]);
  });

  it("stop sends false with silentMs 0 only after a true", async () => {
    const { sent, a, clock } = harness();
    a.stop("a");
    expect(sent).toEqual([]);
    a.speechStarted("a");
    const outcome = deferred();
    a.segmentClosed("a", clock.t, outcome.promise);
    a.stop("a");
    expect(sent).toEqual([{ type: "speech_activity", roleId: "a", active: true }, { type: "speech_activity", roleId: "a", active: false, silentMs: 0 }]);
    a.stop("a");
    outcome.resolve(); // the pending close is stale now: no second false
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
  });

  it("a rejected outcome still sends the edge (it is never left open)", async () => {
    const { sent, a, clock } = harness();
    a.speechStarted("a");
    a.segmentClosed("a", clock.t, Promise.reject(new Error("x")));
    await vi_waitFor(() => sent.length === 2);
    expect(sent[1]).toMatchObject({ active: false });
  });
});

/** Waits (microtask and macrotask turns, no real timer) until `cond` holds. */
async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}
