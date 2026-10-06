import { stampNonce } from "../demo/harness.js";
import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario, validateScenario } from "@acr/script";
import { MockModelProvider, type ChatRequest } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { SessionEngine } from "../engine/session-engine.js";
import { MemoryEventLog } from "../engine/event-log.js";
import { FakeClock } from "../engine/clock.js";
import { SessionHost } from "../host/session-host.js";
import { startServer } from "../host/ws-server.js";
import { bootstrap, type Runtime } from "../main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../../../../scenarios/friday-escalation");
const MIN = 60_000;

// Distinctive strings from the real scenario files and from this test. None may ever reach a model prompt.
const NEVER_IN_PROMPTS = {
  rubric: ["individual_delivery_v2", "group_collaboration_v1", "commercial_judgement", "team_alignment", "role_clarity",
    "Protect scope and margin while preserving the relationship", "agreeing to the module in scene 2 without pricing it"],
  hiddenFact: ["phased delivery after go-live if the risk"],
  otherRolesBriefs: ["6 person-weeks", "three times this programme", "renewal decision maker", "ingestion layer", "half the effort", "puts the go-live date at",
    "You run the programme day to day", "You own the architecture", "You own the commercial relationship"],
  participantNames: ["ZedAlphaParticipant", "ZedBravoParticipant", "ZedCharlieParticipant"],
  facilitatorWhisper: ["WHISPER-ONLY-FOR-DELIVERY-LEAD"],
};
const allMarkers = Object.values(NEVER_IN_PROMPTS).flat();
const promptText = (req: ChatRequest) => req.system + "\n" + JSON.stringify(req.messages);

type Client = ReturnType<typeof connect>;
/** Records every server message; waitFor resolves on arrival (no polling, no fixed sleeps; the timeout only guards a hung test). */
function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: any[] = [];
  const waiters: { from: number; pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (d) => {
    inbox.push(JSON.parse(d.toString()));
    for (const w of [...waiters]) {
      const hit = inbox.slice(w.from).find(w.pred);
      if (hit) { waiters.splice(waiters.indexOf(w), 1); w.resolve(hit); }
    }
  });
  const ready = new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
  const waitFor = (pred: (m: any) => boolean, from = 0) => new Promise<any>((resolve, reject) => {
    const hit = inbox.slice(from).find(pred);
    if (hit) return resolve(hit);
    const w = { from, pred, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timed out waiting for a server message")); } }, 5_000).unref();
  });
  return { ws, inbox, ready, waitFor, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
const events = (c: Client): SessionEvent[] => c.inbox.filter((m) => m.type === "event").map((m) => m.event);

let server: Awaited<ReturnType<typeof startServer>> | null = null;
let clients: Client[] = [];
let tmp: string | null = null;
let runtime: Runtime | null = null;
afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  await server?.close(); server = null;
  await runtime?.stop(); runtime = null;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("The Friday Escalation scenario package", () => {
  it("loads and validates with no errors and no warnings", async () => {
    const { errors, warnings } = validateScenario(await loadScenario(dir));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]); // no intentional warnings in this scenario
  });

  it("works against the default SCENARIO_DIR used by bootstrap()", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-sim-"));
    await cp(dir, path.join(tmp, "scenarios", "friday-escalation"), { recursive: true });
    const logs: string[] = []; const warns: string[] = [];
    const r = await bootstrap({ env: { RUNTIME_PORT: "0", SESSION_ID: "sim", MODEL_PROVIDER: "mock" }, root: tmp, logDir: tmp, tickMs: 10_000, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(warns).toEqual([]);
    expect(logs.join("\n")).toContain("The Friday Escalation");
    const fac = connect(runtime.port); clients.push(fac); await fac.ready;
    fac.send({ type: "join_facilitator", sessionId: "sim" });
    const joined = await fac.waitFor((m) => m.type === "joined");
    expect(joined.roleId).toBe("facilitator");
  });
});

describe("The Friday Escalation, simulated end to end", () => {
  it("plays all three scenes over a real websocket with scripted models and a fake clock", async () => {
    const scenario = await loadScenario(dir);
    const clock = new FakeClock(0);
    const log = new MemoryEventLog("sim"); // a fresh in-memory log: the engine refuses to start on a non-empty one
    const engine = new SessionEngine({ scenario, log, clock });
    const npc = new MockModelProvider([
      "Thanks for calling. So, can you confirm the reconciliation module for go-live?",
      "I hear you. What would phasing actually look like for Finance?",
      "Hm. Can you put a number on that?",
      "Alright. Send me the phased plan by Monday and I will take it to the CFO.",
    ]);
    const gm = new MockModelProvider([
      '{"verdict": false, "reasoning": "still discussing"}',
      '{"verdict": true, "reasoning": "delivery lead summarised one position and the others agreed"}',
      '{"verdict": false, "reasoning": "no next step yet"}',
      '{"verdict": true, "reasoning": "a phased plan by Monday was agreed"}',
    ]);
    const logs: string[] = [];
    const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: stampNonce(gm), clock, log: (m) => logs.push(m) });
    server = await startServer({ port: 0, hosts: new Map([["sim", host]]) });

    const join = async (roleId: string, participantId: string) => {
      const c = connect(server!.port); clients.push(c); await c.ready;
      c.send({ type: "join", sessionId: "sim", roleId, participantId });
      const joined = await c.waitFor((m) => m.type === "joined" || m.type === "error");
      expect(joined.type).toBe("joined");
      return { c, joined };
    };
    const fac = connect(server.port); clients.push(fac); await fac.ready;
    fac.send({ type: "join_facilitator", sessionId: "sim" });
    await fac.waitFor((m) => m.type === "joined");
    const dl = await join("delivery_lead", "ZedAlphaParticipant");
    const tl = await join("tech_lead", "ZedBravoParticipant");
    const am = await join("account_manager", "ZedCharlieParticipant");
    const players = { delivery_lead: dl.c, tech_lead: tl.c, account_manager: am.c };

    // Each helper waits for the server's own echo, then for background NPC/GM work (host.idle) to finish.
    const say = async (role: keyof typeof players, text: string) => {
      const c = players[role];
      c.send({ type: "say", text });
      await c.waitFor((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === role && m.event.text === text);
      await host.idle();
    };
    const command = async (cmd: Record<string, unknown>) => {
      const from = fac.inbox.length;
      fac.send({ type: "command", command: cmd });
      await fac.waitFor((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === cmd.command, from);
      await host.idle();
    };

    // A player cannot start the session; only the facilitator can.
    dl.c.send({ type: "start" });
    expect((await dl.c.waitFor((m) => m.type === "error")).code).toBe("forbidden");
    expect(engine.state.status).toBe("idle");
    fac.send({ type: "start" });
    await am.c.waitFor((m) => m.type === "event" && m.event.type === "inject.fired");

    // Scene 1: the opening inject lands for all three players; no NPC is in the room.
    expect(engine.state.currentScene?.id).toBe("s1_huddle");
    expect(engine.state.injectsFired).toEqual(["email_from_priya"]);
    await say("delivery_lead", "Did everyone see Priya's email?");
    await say("tech_lead", "Yes. Doing it before go-live is a real risk.");
    await say("account_manager", "And the renewal is live, so we can't just say no.");
    expect(gm.calls).toHaveLength(1); // first evaluation after three lines
    expect(npc.calls).toHaveLength(0); // Priya is absent from the huddle and never speaks
    expect(engine.state.currentScene?.id).toBe("s1_huddle"); // first verdict was false
    await say("delivery_lead", "Position: we offer a phased module after go-live, priced, and explain the risk.");
    await say("tech_lead", "Agreed.");
    await say("account_manager", "Agreed.");
    expect(npc.calls).toHaveLength(0);
    expect(engine.state.transcript.some((u) => u.roleId === "client_sponsor")).toBe(false);
    expect(engine.state.currentScene?.id).toBe("s2_client_call"); // second verdict true: GM-driven exit
    expect(engine.state.sceneHistory[0]).toMatchObject({ id: "s1_huddle" });

    // Scene 2: Priya replies to every player line; the CFO inject fires exactly at minute 7.
    await command({ command: "whisper", roleId: "delivery_lead", text: "WHISPER-ONLY-FOR-DELIVERY-LEAD ask about timing" });
    await say("delivery_lead", "Hi Priya, thanks for making time.");
    expect(engine.state.transcript.at(-1)?.roleId).toBe("client_sponsor");
    expect(npc.calls).toHaveLength(1);
    clock.advance(7 * MIN - 1_000);
    await command({ command: "resume" }); // any command schedules a GM tick, which fires due injects
    expect(engine.state.injectsFired).not.toContain("cfo_pressure"); // 6:59, too early
    clock.advance(1_000);
    await command({ command: "resume" });
    expect(engine.state.injectsFired).toContain("cfo_pressure"); // 7:00 on the dot
    expect(engine.state.npcs.client_sponsor.goals).toContain("Get a yes on this call");
    await say("account_manager", "We can phase the module after go-live and price it properly.");
    expect(engine.state.currentScene?.id).toBe("s2_client_call"); // third verdict false
    expect(npc.calls.at(-1) && promptText(npc.calls.at(-1)!)).toContain("Get a yes on this call"); // the inject's effect reached Priya
    await say("delivery_lead", "We'll send the phased plan by Monday.");
    await say("account_manager", "Does that work?");
    expect(engine.state.currentScene?.id).toBe("s3_internal_wrap"); // fourth verdict true
    expect(npc.calls).toHaveLength(4);

    // Scene 3: Priya is gone again; the facilitator advances before the 8 minute box runs out.
    await say("tech_lead", "I will write up the phased estimate.");
    expect(npc.calls).toHaveLength(4);
    clock.advance(8 * MIN - 1_000);
    await command({ command: "resume" });
    expect(engine.state.status).toBe("running"); // 7:59 into the time box
    await command({ command: "advance" });
    expect(engine.state.status).toBe("ended");
    await fac.waitFor((m) => m.type === "event" && m.event.type === "session.ended");
    await host.idle();
    expect(logs).toEqual([]); // no background failures were swallowed

    // The event log: monotonic seq from 1 and the exact sequence of event types.
    const all = await log.all();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    const trace = all.map((e) => {
      switch (e.type) {
        case "scene.entered": case "scene.exited": return `${e.type}:${e.sceneId}${e.type === "scene.exited" ? `:${e.reason}` : ""}`;
        case "inject.fired": return `${e.type}:${e.injectId}`;
        case "utterance": return `utterance:${e.roleId}`;
        case "facilitator.command": return `${e.type}:${e.command}`;
        case "gm.decision": return `${e.type}:${e.verdict}`;
        case "session.ended": return `${e.type}:${e.reason}`;
        default: return e.type;
      }
    });
    expect(trace).toEqual([
      "session.started", "npc.updated",
      "scene.entered:s1_huddle", "inject.fired:email_from_priya",
      "utterance:delivery_lead", "utterance:tech_lead", "utterance:account_manager", "gm.decision:false",
      "utterance:delivery_lead", "utterance:tech_lead", "utterance:account_manager", "gm.decision:true",
      "scene.exited:s1_huddle:gm_detects", "scene.entered:s2_client_call",
      "facilitator.command:whisper",
      "utterance:delivery_lead", "utterance:client_sponsor",
      "facilitator.command:resume", "facilitator.command:resume", "inject.fired:cfo_pressure", "npc.updated",
      "utterance:account_manager", "utterance:client_sponsor", "gm.decision:false",
      "utterance:delivery_lead", "utterance:client_sponsor",
      "utterance:account_manager", "utterance:client_sponsor", "gm.decision:true",
      "scene.exited:s2_client_call:gm_detects", "scene.entered:s3_internal_wrap",
      "utterance:tech_lead",
      "facilitator.command:resume", "facilitator.command:advance",
      "scene.exited:s3_internal_wrap:facilitator_advance", "session.ended:script_complete",
    ]);
    expect(all.filter((e) => e.type === "gm.decision")).toHaveLength(4);
    expect(all.at(-1)).toMatchObject({ type: "session.ended", reason: "script_complete" });

    // Guardrails: nothing secret ever reached a model prompt, in any captured request.
    expect(npc.calls.length + gm.calls.length).toBe(8);
    for (const req of [...npc.calls, ...gm.calls]) {
      const text = promptText(req);
      for (const marker of allMarkers) expect(text, `prompt leaked ${marker}`).not.toContain(marker);
    }
    // Positive controls so the absence checks above are not vacuous.
    expect(promptText(npc.calls[0])).toContain("time-poor"); // her own persona is in
    expect(promptText(gm.calls[0])).toContain("a single agreed position on the request");

    // The players' point of view.
    const everything = (c: Client) => JSON.stringify(c.inbox);
    for (const [role, c] of Object.entries(players)) {
      const seen = events(c);
      for (const e of seen) expect(["npc.updated", "gm.decision", "facilitator.alert"]).not.toContain(e.type);
      for (const name of NEVER_IN_PROMPTS.participantNames) expect(everything(c), `${role} saw ${name}`).not.toContain(name);
      const started = seen.find((e) => e.type === "session.started");
      expect(started).toBeDefined();
      for (const r of Object.values((started as Extract<SessionEvent, { type: "session.started" }>).roles)) expect(Object.keys(r)).toEqual(["kind"]);
      expect(everything(c)).not.toContain("participantId");
      // no CFO inject (addressed to the NPC only), and the facilitator's NPC-side data stays private
      expect(everything(c)).not.toContain("CFO messages her");
      expect(everything(c)).not.toContain("Get a yes on this call");
      // other roles' private facts and briefs are never delivered
      for (const marker of ["6 person-weeks", "three times this programme", "half the effort"]) {
        if (role === "delivery_lead" && marker === "6 person-weeks") continue; // their own
        if (role === "account_manager" && marker === "three times this programme") continue;
        if (role === "tech_lead" && marker === "half the effort") continue;
        expect(everything(c), `${role} saw ${marker}`).not.toContain(marker);
      }
    }
    // The whisper reached only its addressee.
    const whisperSeen = (c: Client) => events(c).some((e) => e.type === "facilitator.command" && e.command === "whisper");
    expect(whisperSeen(dl.c)).toBe(true);
    expect(whisperSeen(tl.c)).toBe(false);
    expect(whisperSeen(am.c)).toBe(false);
    expect(everything(tl.c)).not.toContain("WHISPER-ONLY-FOR-DELIVERY-LEAD");
    expect(everything(am.c)).not.toContain("WHISPER-ONLY-FOR-DELIVERY-LEAD");
    // The tech lead sits out the client call: none of Priya's scene is delivered to them.
    expect(events(tl.c).some((e) => e.type === "utterance" && e.roleId === "client_sponsor")).toBe(false);
    expect(events(tl.c).some((e) => e.type === "scene.entered" && e.sceneId === "s2_client_call")).toBe(false);
    // The facilitator sees all of it (positive control for the filters).
    const facTypes = new Set(events(fac).map((e) => e.type));
    expect(facTypes).toContain("gm.decision");
    expect(facTypes).toContain("npc.updated");
    expect(everything(fac)).toContain("ZedAlphaParticipant");
    // Joining gave each player only their own private facts.
    expect(dl.joined.privateFacts).toContain("The module is roughly 6 person-weeks of work");
    expect(JSON.stringify(dl.joined)).not.toContain("half the effort");
    expect(JSON.stringify(tl.joined)).not.toContain("6 person-weeks");
  });
});
