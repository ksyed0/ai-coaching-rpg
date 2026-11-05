import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bootstrap } from "../../../../runtime/src/main.js";
import { parseBotFrame, type BotFrame } from "../../bots/bot-frames.js";

/**
 * The runtime's REAL frames (booted in-process, unmanaged, mock provider, a private temp data dir) parsed by the control service's own
 * copy of the wire shapes. A flattened `joined` (state keys at the top level) must not parse: that is what this test guards.
 */
const SCENARIOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const ROLES = ["account_manager", "delivery_lead", "tech_lead"];
const DEADLINE_MS = 30_000;

type Raw = { raw: string; json: any };
class Client {
  readonly inbox: Raw[] = [];
  private constructor(readonly ws: WebSocket) { ws.on("message", (d) => { const raw = d.toString(); this.inbox.push({ raw, json: JSON.parse(raw) }); }); }
  static open(port: number): Promise<Client> { return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(new Client(w))); w.on("error", rej); }); }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  async waitFor(what: string, pred: (j: any) => boolean): Promise<Raw> {
    const end = Date.now() + DEADLINE_MS;
    for (;;) {
      const hit = this.inbox.find((m) => pred(m.json));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

let dir: string;
let stop: (() => Promise<void>) | undefined;
let clients: Client[] = [];
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "acr-frames-")); });
afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  await stop?.(); stop = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("the runtime's real frames", () => {
  it("the captured joined, peers roster and utterance event parse to their typed frames with brief, state.lastSeq, state.transcript and scenes filled", async () => {
    let codes: { roleId: string; code: string }[] = [];
    const r = await bootstrap({
      env: { SCENARIO_DIR: SCENARIOS, RUNTIME_PORT: "0", SESSION_ID: "frames1", MODEL_PROVIDER: "mock", NO_DOTENV: "1" },
      root: dir, logDir: dir, tickMs: 60_000, log: () => {}, warn: () => {}, showJoinCodes: (c) => { codes = c; },
    });
    if (!r.ok) throw new Error(r.errors.join("; "));
    stop = () => r.runtime.stop();
    const codeOf = (role: string) => codes.find((c) => c.roleId === role)!.code;
    expect(codes.map((c) => c.roleId).sort()).toEqual(ROLES);

    const seats = new Map<string, Client>();
    for (const role of ROLES) {
      const c = await Client.open(r.runtime.port);
      clients.push(c); seats.set(role, c);
      c.send({ type: "join", sessionId: "frames1", roleId: role, participantId: `p-${role}`, joinCode: codeOf(role) });
      await c.waitFor(`${role} joined`, (j) => j.type === "joined");
    }
    for (const c of seats.values()) { c.send({ type: "consent", noticeVersion: "v2" }); c.send({ type: "say", text: "settle" }); await c.waitFor("consent handled", (j) => j.type === "error" && j.code === "not_started"); }
    const fac = await Client.open(r.runtime.port); clients.push(fac);
    fac.send({ type: "join_facilitator", sessionId: "frames1" });
    await fac.waitFor("facilitator joined", (j) => j.type === "joined");
    fac.send({ type: "start" });
    const tech = seats.get("tech_lead")!;
    await tech.waitFor("scene entered", (j) => j.type === "event" && j.event.type === "scene.entered");
    const speaker = seats.get("account_manager")!;
    speaker.send({ type: "say", text: "Morning everyone, a quick status before we start." });
    const utter = await tech.waitFor("the utterance", (j) => j.type === "event" && j.event.type === "utterance" && j.event.roleId === "account_manager");

    // A rejoin of the tech lead (the old socket closed first) sees the transcript and lastSeq in its joined frame.
    await new Promise<void>((res) => { tech.ws.once("close", () => res()); tech.ws.close(1000); });
    const rejoin = await Client.open(r.runtime.port); clients.push(rejoin);
    rejoin.send({ type: "join", sessionId: "frames1", roleId: "tech_lead", participantId: "p-tech_lead", joinCode: codeOf("tech_lead") });
    const joinedRaw = await rejoin.waitFor("rejoin joined", (j) => j.type === "joined");
    const joined = parseBotFrame(joinedRaw.raw);
    expect(joined.type).toBe("joined");
    if (joined.type !== "joined") return;
    expect(joined.roleId).toBe("tech_lead");
    expect(joined.brief.length).toBeGreaterThan(10);
    expect(joined.state.status).toBe("running");
    expect(joined.state.lastSeq).toBeGreaterThan(0);
    expect(joined.state.currentScene?.participants).toContain("tech_lead");
    expect(joined.state.transcript.some((l) => l.roleId === "account_manager" && l.text.startsWith("Morning everyone"))).toBe(true);
    expect(joined.scenes.length).toBeGreaterThan(0);
    for (const sc of joined.scenes) expect(Object.keys(sc).sort()).toEqual(["goal", "id", "title"]);
    expect(typeof joined.reconnectToken).toBe("string");
    // A flattened joined (the state's keys lifted to the top level) must not parse.
    const { state, ...rest } = joinedRaw.json;
    expect(parseBotFrame(JSON.stringify({ ...rest, ...state })).type).toBe("ignored");

    const roster = tech.inbox.find((m) => m.json.type === "roster" && m.json.audience === "peers");
    expect(roster).toBeDefined();
    const rosterFrame = parseBotFrame(roster!.raw);
    expect(rosterFrame.type).toBe("roster");
    if (rosterFrame.type === "roster") {
      expect(rosterFrame.entries.map((e) => e.roleId).sort()).toEqual(ROLES);
      expect(rosterFrame.entries.every((e) => e.ai === false)).toBe(true);
    }
    expect(tech.inbox.some((m) => m.json.type === "roster" && m.json.audience === "facilitator")).toBe(false);

    const ev: BotFrame = parseBotFrame(utter.raw);
    expect(ev).toEqual({ type: "event", event: { seq: utter.json.event.seq, type: "utterance", roleId: "account_manager", text: "Morning everyone, a quick status before we start." } });
    // Every frame the tech lead received parses to something typed or is deliberately ignored; none throws.
    for (const m of tech.inbox) expect(() => parseBotFrame(m.raw)).not.toThrow();
  });
});
