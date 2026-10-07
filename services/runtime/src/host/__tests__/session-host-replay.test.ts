import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import { MemoryEventLog, type EventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS, SessionHost } from "../session-host.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../../scenarios/friday-escalation");
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
const VIEWERS = [...PLAYERS, "facilitator"] as const;
const WHISPER_TL = "ZedSecretForTechLeadOnly";
const WHISPER_DL = "ZedSecretForDeliveryLeadOnly";
const ALERT = "ZedFacilitatorOnlyAlert";
const REASONING = "ZedGameMasterReasoning";
const STANCE = "ZedNpcStanceGoal";

function system(scenario: Scenario, o: { log?: EventLog; clock?: FakeClock; retainEvents?: number } = {}) {
  const clock = o.clock ?? new FakeClock(1_000);
  const log = o.log ?? new MemoryEventLog("s");
  const engine = new SessionEngine({ scenario, log, clock, retainEvents: o.retainEvents });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider([]), gmProvider: new MockModelProvider([]), clock });
  return { engine, host, log, clock };
}

/** What each viewer receives live, through the same viewFor the server uses, from the very first event. */
function recordLive(host: SessionHost): Record<string, SessionEvent[]> {
  const got: Record<string, SessionEvent[]> = Object.fromEntries(VIEWERS.map((v) => [v, []]));
  for (const v of VIEWERS) host.subscribe((e) => { const view = host.viewFor(v, e); if (view) got[v]!.push(view); });
  return got;
}

/** Every kind of event the filter decides on, including whispers to different roles, a hidden-fact release and facilitator-only ones. */
async function playEverything(engine: SessionEngine, host: SessionHost, clock: FakeClock): Promise<void> {
  for (const r of PLAYERS) host.join(r, `${r}-person`);
  await host.start();
  await engine.say("delivery_lead", "scene 1, delivery lead");
  await engine.command({ command: "whisper", roleId: "tech_lead", text: WHISPER_TL });
  await engine.command({ command: "whisper", roleId: "delivery_lead", text: WHISPER_DL });
  await engine.say("tech_lead", "scene 1, tech lead");
  await engine.command({ command: "pause" });
  await engine.command({ command: "resume" });
  await engine.alert(ALERT, "warning");
  await engine.recordGmVerdict("the team has stated a single agreed position on the request", false, REASONING);
  await engine.recordGmNoVerdict("the team has stated a single agreed position on the request", "no_json", 2);
  await engine.command({ command: "advance" }); await engine.tick(); // scene 2: delivery_lead, account_manager, client_sponsor
  await engine.say("account_manager", "scene 2, account manager");
  await engine.say("client_sponsor", "scene 2, the client");
  await engine.command({ command: "release_hidden", roleId: "client_sponsor", fact: 1 });
  await engine.command({ command: "set_npc_stance", roleId: "client_sponsor", goals: [STANCE] });
  await engine.command({ command: "whisper", roleId: "tech_lead", text: `${WHISPER_TL} (not in this scene)` });
  clock.advance(7 * 60_000); await engine.tick(); // the timed inject to the client only
  await engine.command({ command: "advance" }); await engine.tick(); // scene 3: the three players
  await engine.say("tech_lead", "scene 3, tech lead");
  await engine.command({ command: "advance" }); await engine.tick(); // the end
}

describe("SessionHost.replayFor (US-0013, AC-0039, AC-0170, AC-0171)", () => {
  it("test_replay_for_every_viewer_and_every_seq_equals_what_it_received_live", async () => {
    const scenario = await loadScenario(friday);
    const { engine, host, clock } = system(scenario);
    const live = recordLive(host);
    await playEverything(engine, host, clock);
    const head = engine.state.lastSeq;
    expect(engine.state.status).toBe("ended");
    expect(live.tech_lead!.some((e) => e.type === "facilitator.command" && e.command === "whisper")).toBe(true);
    for (const v of VIEWERS) {
      for (let k = 0; k <= head; k++) {
        const r = host.replayFor(v, k);
        expect(r.complete).toBe(true);
        expect(r.afterSeq).toBe(k);
        expect(r.toSeq).toBe(head);
        // Exactly the events after k this viewer may see, in order, no gaps and no duplicates.
        expect(r.events).toEqual(live[v]!.filter((e) => e.seq > k));
      }
    }
  });

  it("test_replay_never_gives_a_player_another_roles_whisper_or_facilitator_only_data", async () => {
    const scenario = await loadScenario(friday);
    const { engine, host, clock } = system(scenario);
    await playEverything(engine, host, clock);
    const npc = Object.values(scenario.roles).find((r): r is NpcRole => r.type === "npc")!;
    for (const p of PLAYERS) {
      const raw = JSON.stringify(host.replayFor(p, 0).events);
      expect(raw).not.toContain(ALERT);
      expect(raw).not.toContain(REASONING);
      expect(raw).not.toContain(STANCE);
      expect(raw).not.toContain("-person"); // participant names
      for (const h of npc.hidden) expect(raw).not.toContain(h);
      for (const g of npc.goals) expect(raw).not.toContain(g);
      const types = new Set(host.replayFor(p, 0).events.map((e) => e.type));
      for (const t of ["npc.updated", "gm.decision", "gm.no_verdict", "facilitator.alert"]) expect(types.has(t as SessionEvent["type"])).toBe(false);
      if (p !== "tech_lead") expect(raw).not.toContain(WHISPER_TL);
      if (p !== "delivery_lead") expect(raw).not.toContain(WHISPER_DL);
    }
    expect(JSON.stringify(host.replayFor("tech_lead", 0).events)).not.toContain("scene 2, the client"); // tech_lead is not in scene 2
    // The facilitator replays everything, and a role id that is no role gets only what everyone sees.
    expect(host.replayFor("facilitator", 0).events.length).toBe(engine.state.lastSeq);
    expect(JSON.stringify(host.replayFor("__proto__", 0).events)).not.toContain("Zed");
  });

  it("test_replay_over_the_event_or_byte_cap_sends_nothing_and_says_it_is_incomplete", async () => {
    const scenario = await loadScenario(friday);
    const { engine, host, clock } = system(scenario);
    await playEverything(engine, host, clock);
    const full = host.replayFor("delivery_lead", 0);
    expect(full.events.length).toBeGreaterThan(3);
    expect(host.replayFor("delivery_lead", 0, { maxEvents: full.events.length }).complete).toBe(true);
    const byCount = host.replayFor("delivery_lead", 0, { maxEvents: full.events.length - 1 });
    expect(byCount).toEqual({ afterSeq: 0, toSeq: engine.state.lastSeq, complete: false, events: [] });
    const bytes = full.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
    expect(host.replayFor("delivery_lead", 0, { maxBytes: bytes }).complete).toBe(true);
    expect(host.replayFor("delivery_lead", 0, { maxBytes: bytes - 1 })).toMatchObject({ complete: false, events: [] });
    expect(MAX_REPLAY_EVENTS).toBe(1000);
    expect(MAX_REPLAY_BYTES).toBe(256 * 1024);
  });

  it("test_replay_from_before_the_retained_window_is_incomplete_not_partial", async () => {
    const scenario = await loadScenario(friday);
    const { engine, host, clock } = system(scenario, { retainEvents: 5 });
    await playEverything(engine, host, clock);
    const head = engine.state.lastSeq;
    expect(host.replayFor("facilitator", head - 5).complete).toBe(true);
    expect(host.replayFor("facilitator", head - 6)).toEqual({ afterSeq: head - 6, toSeq: head, complete: false, events: [] });
  });

  it("test_replay_refuses_a_seq_that_is_not_a_whole_number_within_the_log", async () => {
    const scenario = await loadScenario(friday);
    const { engine, host, clock } = system(scenario);
    await playEverything(engine, host, clock);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, engine.state.lastSeq + 1]) {
      expect(() => host.replayFor("delivery_lead", bad)).toThrow(RangeError);
    }
  });

  it("test_replay_after_a_restart_continues_the_same_seqs_and_adds_only_what_the_role_may_see", async () => {
    const scenario = await loadScenario(friday);
    const log = new MemoryEventLog("s");
    const clock = new FakeClock(1_000);
    const a = system(scenario, { log, clock });
    const live = recordLive(a.host);
    for (const r of PLAYERS) a.host.join(r, `${r}-person`);
    await a.host.start();
    await a.engine.say("delivery_lead", "before the crash");
    await a.engine.command({ command: "whisper", roleId: "tech_lead", text: WHISPER_TL });
    const crashAt = a.engine.state.lastSeq;
    // The restart: a new engine and host on the same log (US-0018), restored and marked resumed.
    const b = system(scenario, { log, clock });
    const out = await b.engine.restore();
    expect(out.kind).toBe("running");
    if (out.kind !== "running") return;
    await b.engine.markResumed(out.info);
    b.host.resumeFrom(out.info);
    for (const v of VIEWERS) {
      for (let k = 0; k <= crashAt; k++) {
        const r = b.host.replayFor(v, k);
        const after = r.events.filter((e) => e.seq > crashAt).map((e) => e.type);
        expect(r.events.filter((e) => e.seq <= crashAt)).toEqual(live[v]!.filter((e) => e.seq > k));
        // A player learns the session came back paused; the restart alert is the facilitator's only.
        expect(after).toEqual(v === "facilitator" ? ["session.resumed", "facilitator.alert"] : ["session.resumed"]);
      }
    }
  });
});
