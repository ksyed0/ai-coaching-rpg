import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { MemoryEventLog } from "../event-log.js";
import { SessionEngine } from "../session-engine.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const seqsAfter = (engine: SessionEngine, after: number) => {
  const r = engine.eventsAfter(after);
  return r.complete ? [...r.events].map((e) => e.seq) : null;
};

describe("SessionEngine.eventsAfter (US-0013): the retained window replay reads from", () => {
  it("test_engine_events_after_matches_the_log_and_the_state_head", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
    expect(seqsAfter(engine, 0)).toEqual([]);
    await engine.start({ host: "p1" });
    await engine.say("host", "hello");
    await engine.command({ command: "whisper", roleId: "host", text: "psst" });
    const all = await log.all();
    expect(seqsAfter(engine, 0)).toEqual(all.map((e) => e.seq));
    expect(seqsAfter(engine, 2)).toEqual(all.slice(2).map((e) => e.seq));
    expect(seqsAfter(engine, engine.state.lastSeq)).toEqual([]);
    // The very objects the subscribers got (and the log holds): replay never re-derives an event.
    const r = engine.eventsAfter(0);
    expect(r.complete && [...r.events]).toEqual(all);
  });

  it("test_engine_events_after_reports_incomplete_once_the_start_is_evicted", async () => {
    const scenario = await loadScenario(fixture);
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0), retainEvents: 3 });
    await engine.start({ host: "p1" });
    for (let i = 0; i < 4; i++) await engine.say("host", `line ${i}`);
    const head = engine.state.lastSeq;
    expect(seqsAfter(engine, head - 3)).toEqual([head - 2, head - 1, head]);
    expect(engine.eventsAfter(head - 4).complete).toBe(false);
    expect(engine.eventsAfter(0).complete).toBe(false);
    // Outside the log: also not complete (the host refuses such a seq before asking).
    expect(engine.eventsAfter(head + 1).complete).toBe(false);
  });

  it("test_engine_restore_refills_the_window_from_the_log", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const clock = new FakeClock(0);
    const first = new SessionEngine({ scenario, log, clock });
    await first.start({ host: "p1" });
    await first.say("host", "before the restart");
    const again = new SessionEngine({ scenario, log, clock, retainEvents: 4 });
    const out = await again.restore();
    expect(out.kind).toBe("running");
    const head = again.state.lastSeq;
    expect(seqsAfter(again, head - 4)).toEqual((await log.all()).slice(-4).map((e) => e.seq));
    if (out.kind === "running") await again.markResumed(out.info);
    expect(seqsAfter(again, head)).toEqual([head + 1, head + 2]); // session.resumed and the facilitator alert
  });

  it("test_engine_restore_replays_an_event_that_reached_the_log_but_no_client", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const clock = new FakeClock(0);
    const first = new SessionEngine({ scenario, log, clock });
    const seen: number[] = [];
    first.subscribe((e) => seen.push(e.seq));
    await first.start({ host: "p1" });
    // As after a fail-stop: the event is on disk, but the engine never applied or delivered it (the log is the truth).
    const orphan = await log.append({ type: "facilitator.command", command: "whisper", roleId: "host", text: "never delivered" }, 0);
    expect(seen).not.toContain(orphan.seq);
    const again = new SessionEngine({ scenario, log, clock });
    expect((await again.restore()).kind).toBe("running");
    const r = again.eventsAfter(orphan.seq - 1);
    expect(r.complete && [...r.events]).toEqual([orphan]);
  });

  it("test_engine_restore_of_an_ended_log_retains_nothing", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const clock = new FakeClock(0);
    const first = new SessionEngine({ scenario, log, clock });
    await first.start({ host: "p1" });
    await first.command({ command: "advance" }); await first.tick();
    await first.command({ command: "advance" }); await first.tick();
    expect(first.state.status).toBe("ended");
    const again = new SessionEngine({ scenario, log, clock });
    expect((await again.restore()).kind).toBe("ended");
    expect(again.state.lastSeq).toBe(0);
    expect(seqsAfter(again, 0)).toEqual([]);
  });
});
