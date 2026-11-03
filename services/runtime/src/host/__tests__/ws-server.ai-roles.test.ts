import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
import { AuthThrottle } from "../security.js";
// US-0060: AI seats over the socket. Real-socket tests: a generous explicit limit; nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

class CountingThrottle extends AuthThrottle {
  calls = 0;
  override fail(ip: string, scope = ""): void { this.calls++; super.fail(ip, scope); }
}

const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v1", text: "What we record and why." };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { drop(): void; inbox: any[]; closed: Promise<{ code: number; reason: string }>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (c, why) => r({ code: c, reason: why.toString() })));
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { drop: () => ws.terminate(), inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

async function setup(o: { aiRoles?: string[]; authThrottle?: AuthThrottle } = {}) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(7_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const aiRoles = AiRoleSet.fromRecord({ v: 1, ...BIND, roles: o.aiRoles ?? ["tech_lead"] }, { ...BIND, roleIds: PLAYERS });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), aiRoles, persist: vi.fn() };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const { codes, plain } = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]), ...(o.authThrottle ? { authThrottle: o.authThrottle } : {}) });
  return { port: server.port, host, engine, seats, plain };
}

/** Joins a role by code on the web (with a credential); `displayName` is left out when undefined. */
async function seat(port: number, roleId: string, code: string, participantId: string, displayName?: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: code, issueCredential: true, ...(displayName !== undefined ? { displayName } : {}) });
  return { c, j: await c.next((m) => m.type === "joined") };
}
async function facilitator(port: number): Promise<Client> {
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "local" });
  await f.next((m) => m.type === "joined");
  return f;
}
async function consent(c: Client, seats: Seats, roleId: string, participantId: string) {
  c.send({ type: "consent", noticeVersion: "v1" });
  await vi.waitFor(() => expect(seats.consent.has(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
}
/** Both humans joined and consented. */
async function humans(port: number, seats: Seats, plain: Record<string, string>) {
  const a = await seat(port, "account_manager", plain.account_manager!, "alice", "Alice");
  await consent(a.c, seats, "account_manager", "alice");
  const d = await seat(port, "delivery_lead", plain.delivery_lead!, "dana", "Dana");
  await consent(d.c, seats, "delivery_lead", "dana");
  return { a, d };
}

describe("the start gate with AI seats (US-0060)", () => {
  it("with nobody seated start is refused naming the humans first, then the AI role without a bot", async () => {
    const { port, engine } = await setup();
    const f = await facilitator(port);
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toEqual({ type: "error", code: "seats_not_ready", message: "seats_not_ready: account_manager,delivery_lead,tech_lead" });
    expect(engine.state.status).toBe("idle");
  });

  it("with both humans consented and no bot the refusal names only tech_lead", async () => {
    const { port, seats, plain, engine } = await setup();
    await humans(port, seats, plain);
    const f = await facilitator(port);
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toEqual({ type: "error", code: "seats_not_ready", message: "seats_not_ready: tech_lead" });
    expect(engine.state.status).toBe("idle");
  });

  it("an unconsented human still blocks the start although the bot is connected", async () => {
    const { port, seats, plain } = await setup();
    const a = await seat(port, "account_manager", plain.account_manager!, "alice", "Alice");
    await consent(a.c, seats, "account_manager", "alice");
    await seat(port, "delivery_lead", plain.delivery_lead!, "dana", "Dana"); // joined, no consent
    await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    const f = await facilitator(port);
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toMatchObject({ code: "seats_not_ready", message: "seats_not_ready: delivery_lead" });
  });

  it("with the bot joined (no consent) start succeeds: aiRoles recorded, log format 3, no consent entry for the bot", async () => {
    const { port, seats, plain, engine } = await setup();
    await humans(port, seats, plain);
    await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    const f = await facilitator(port);
    f.send({ type: "start" });
    const started = (await f.next((m) => m.type === "event" && m.event.type === "session.started")).event;
    expect(started.aiRoles).toEqual(["tech_lead"]);
    expect(started.logFormat).toBe(3);
    expect(Object.keys(started.consents).sort()).toEqual(["account_manager", "delivery_lead"]);
    expect(started.names.tech_lead).toBe("AI player");
    expect(engine.state.aiRoles).toEqual(["tech_lead"]);
  });

  it("a session without AI roles: the refusal, joined frames and session.started are as before (format 2, no aiRoles key)", async () => {
    const { port, seats, plain, host } = await setup({ aiRoles: [] });
    const f0 = await facilitator(port);
    f0.send({ type: "start" });
    expect(await f0.next((m) => m.type === "error")).toMatchObject({ message: "seats_not_ready: account_manager,delivery_lead,tech_lead" });
    const { a, d } = await humans(port, seats, plain);
    expect(a.j.consent).toEqual({ noticeVersion: "v1", notice: NOTICE.text, given: false });
    expect(d.j.consent.given).toBe(false);
    const t = await seat(port, "tech_lead", plain.tech_lead!, "tess", "Tess");
    expect(t.j.consent).toMatchObject({ given: false });
    await consent(t.c, seats, "tech_lead", "tess");
    const f = await facilitator(port);
    f.send({ type: "start" });
    const started = (await f.next((m) => m.type === "event" && m.event.type === "session.started")).event;
    expect(started.logFormat).toBe(2);
    expect(started).not.toHaveProperty("aiRoles");
    expect(host.isAiRole("tech_lead")).toBe(false);
    expect(host.aiRoleIds()).toEqual([]);
  });
});

describe("AI seats over the socket (US-0060)", () => {
  it("the host reports AI roles from the seats before the start and from the state after it", async () => {
    const { port, seats, plain, host } = await setup();
    expect(host.isAiRole("tech_lead")).toBe(true);
    expect(host.isAiRole("account_manager")).toBe(false);
    expect(host.aiRoleIds()).toEqual(["tech_lead"]);
    await humans(port, seats, plain);
    await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    const f = await facilitator(port);
    f.send({ type: "start" });
    await f.next((m) => m.type === "event" && m.event.type === "session.started");
    seats.aiRoles!.replace([]); // after the start the log's record counts, not the seat file
    expect(host.isAiRole("tech_lead")).toBe(true);
    expect(host.aiRoleIds()).toEqual(["tech_lead"]);
    expect(host.isAiRole("delivery_lead")).toBe(false);
  });

  it("the bot's credential is named \"AI player\" whether its join sent no displayName or \"Bob\"", async () => {
    const { port, seats, plain } = await setup();
    const first = await seat(port, "tech_lead", plain.tech_lead!, "bot1", "Bob");
    expect(seats.credentials.names().tech_lead).toBe("AI player");
    first.c.send({ type: "leave" });
    await first.c.closed;
    await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    expect(seats.credentials.names().tech_lead).toBe("AI player");
  });

  it("joined for tech_lead has no consent field; consent and withdraw_consent are forbidden, the store is unchanged and leave still frees the seat", async () => {
    const { port, seats, plain, host } = await setup();
    const { c, j } = await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    expect(j).not.toHaveProperty("consent");
    c.send({ type: "consent", noticeVersion: "v1" });
    c.send({ type: "withdraw_consent" });
    await c.next(() => c.inbox.filter((m) => m.type === "error").length === 2);
    const errors = c.inbox.filter((m) => m.type === "error");
    expect(errors).toEqual([
      { type: "error", code: "forbidden", message: "an AI player gives no consent" },
      { type: "error", code: "forbidden", message: "an AI player gives no consent" },
    ]);
    expect(seats.consent.snapshot()).toEqual({});
    expect(seats.credentials.has("tech_lead")).toBe(true); // withdraw_consent did not free the seat
    expect(host.assignments.tech_lead).toBe("bot1");
    c.send({ type: "leave" });
    expect(await c.closed).toEqual({ code: 1000, reason: "left" });
    expect(host.assignments.tech_lead).toBeUndefined();
    expect(seats.credentials.has("tech_lead")).toBe(false);
  });

  it("after the start (seat released as a reissue leaves it) a new bot participant rejoins tech_lead and is not refused consent_required, while a different participant for account_manager still is", async () => {
    const { port, seats, plain, host } = await setup();
    const { a } = await humans(port, seats, plain);
    const bot = await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    const f = await facilitator(port);
    f.send({ type: "start" });
    await f.next((m) => m.type === "event" && m.event.type === "session.started");
    await vi.waitFor(() => expect(host.hasStarted).toBe(true), { timeout: 30_000, interval: 5 }); // a leave is refused while the start is in flight
    // What a reissue after the start leaves behind (no leave is possible then): the credential revoked and the seat released.
    bot.c.drop(); a.c.drop();
    await Promise.all([bot.c.closed, a.c.closed]);
    seats.credentials.revoke("tech_lead"); host.release("tech_lead", "bot1");
    seats.credentials.revoke("account_manager"); host.release("account_manager", "alice");
    const again = await seat(port, "tech_lead", plain.tech_lead!, "bot2");
    expect(again.j.roleId).toBe("tech_lead");
    expect(again.j).not.toHaveProperty("consent");
    const other = await open(port);
    other.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "mallory", joinCode: plain.account_manager!, issueCredential: true, displayName: "Mallory" });
    expect(await other.next((m) => m.type === "error")).toMatchObject({ code: "consent_required" });
  });
});

describe("reserved display names (US-0060)", () => {
  // Full-width letters (NFKC), a zero-width space (default-ignorable) and a control character only the name cleaning strips.
  it.each([["ai Player Pat"], ["\uFF21\uFF29 player"], ["A\u200BI player Sam"], ["A\u0007I player Lee"]])("a human join named %j is bad_message and takes no seat", async (name) => {
    const { port, plain, host } = await setup();
    const c = await open(port);
    c.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "alice", joinCode: plain.account_manager!, issueCredential: true, displayName: name });
    expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "bad_message", message: "displayName: names starting with \"AI player\" are reserved" });
    expect(host.assignments.account_manager).toBeUndefined();
  });

  it("a reserved name sent with a WRONG join code is bad_message, not unauthorized, and charges nothing to the throttle", async () => {
    let t = 0;
    const throttle = new CountingThrottle({ max: 2, windowMs: 60_000, blockMs: 60_000, now: () => t });
    const { port, plain } = await setup({ authThrottle: throttle });
    const reserved = await open(port);
    reserved.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "alice", joinCode: "wrong", displayName: "AI player" });
    expect(await reserved.next((m) => m.type === "error")).toMatchObject({ code: "bad_message" });
    expect(throttle.calls).toBe(0);
    // The following wrong-code attempts reach the limit exactly as if the reserved one had never been sent.
    for (let i = 0; i < 2; i++) {
      const c = await open(port);
      c.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "alice", joinCode: "wrong" });
      expect(await c.next((m) => m.type === "error")).toMatchObject({ code: "unauthorized" });
        await c.closed;
    }
    expect(throttle.calls).toBe(2);
  });
});

describe("the roster and player frames with AI seats (US-0060)", () => {
  const rosterOf = (c: Client, audience: string) => [...c.inbox].reverse().find((m) => m.type === "roster" && m.audience === audience)?.entries;

  it("the peers roster before the start shows tech_lead as ai and ready after the bot joined", async () => {
    const { port, plain } = await setup();
    const a = await seat(port, "account_manager", plain.account_manager!, "alice", "Alice");
    expect(await a.c.next((m) => m.type === "roster" && m.entries.some((e: any) => e.roleId === "tech_lead"))).toMatchObject({ audience: "peers" });
    expect(rosterOf(a.c, "peers").find((e: any) => e.roleId === "tech_lead")).toEqual({ roleId: "tech_lead", ready: false, ai: true });
    await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    await a.c.next((m) => m.type === "roster" && m.entries.some((e: any) => e.roleId === "tech_lead" && e.ready));
    expect(rosterOf(a.c, "peers").find((e: any) => e.roleId === "tech_lead")).toEqual({ roleId: "tech_lead", name: "AI player", ready: true, ai: true });
    const human = rosterOf(a.c, "peers").find((e: any) => e.roleId === "account_manager");
    expect(human).not.toHaveProperty("ai");
    const f = await facilitator(port);
    const fr = (await f.next((m) => m.type === "roster" && m.audience === "facilitator")).entries;
    expect(fr.find((e: any) => e.roleId === "tech_lead")).toEqual({ roleId: "tech_lead", name: "AI player", joined: true, consented: false, connected: true, ai: true });
    expect(fr.find((e: any) => e.roleId === "account_manager")).not.toHaveProperty("ai");
  });

  it("a player frame labels an AI line: account_manager's session.started copy lists aiRoles [\"tech_lead\"], the bot's line in scene 1 reaches account_manager with roleId tech_lead, and account_manager rejoining afterwards gets aiRoles [\"tech_lead\"] in its snapshot", async () => {
    const { port, seats, plain } = await setup();
    const { a } = await humans(port, seats, plain);
    const bot = await seat(port, "tech_lead", plain.tech_lead!, "bot1");
    const f = await facilitator(port);
    f.send({ type: "start" });
    const started = await a.c.next((m) => m.type === "event" && m.event.type === "session.started");
    expect(started.event.aiRoles).toEqual(["tech_lead"]);
    bot.c.send({ type: "say", text: "bot line one" });
    const line = await a.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "bot line one");
    expect(line.event.roleId).toBe("tech_lead");
    const again = await open(port);
    again.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "alice", reconnectToken: a.j.reconnectToken });
    const j = await again.next((m) => m.type === "joined" || m.type === "error");
    expect(j.type).toBe("joined");
    expect(j.state.aiRoles).toEqual(["tech_lead"]);
  });

  it("no frame a player receives carries the bot's participant id \"BOT-PID-7\", its credential, its join code, the names table or a consents entry for tech_lead", async () => {
    const { port, seats, plain } = await setup();
    const { a, d } = await humans(port, seats, plain);
    const bot = await seat(port, "tech_lead", plain.tech_lead!, "BOT-PID-7");
    const f = await facilitator(port);
    f.send({ type: "start" });
    const fStarted = (await f.next((m) => m.type === "event" && m.event.type === "session.started")).event;
    bot.c.send({ type: "say", text: "bot line two" });
    await a.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "bot line two");
    await d.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "bot line two");
    // Each marker first exists where it is allowed to: the facilitator socket or the bot's own join reply.
    const credential = bot.j.reconnectToken as string;
    expect(typeof credential).toBe("string");
    expect(credential.length).toBeGreaterThan(8);
    const fText = JSON.stringify(f.inbox);
    expect(fText).toContain("BOT-PID-7");
    expect(JSON.stringify(bot.c.inbox)).toContain(credential);
    expect(fStarted.names).toEqual(expect.objectContaining({ tech_lead: "AI player" }));
    expect(fStarted.roles.tech_lead.participantId).toBe("BOT-PID-7");
    expect(Object.keys(fStarted.consents)).not.toContain("tech_lead"); // by design the bot has no consent entry, for anyone
    for (const p of [a, d]) {
      await vi.waitFor(() => expect(p.c.inbox.some((m) => m.type === "event" && m.event.type === "utterance")).toBe(true), { timeout: 30_000, interval: 5 });
      const text = JSON.stringify(p.c.inbox);
      expect(text).not.toContain("BOT-PID-7");
      expect(text).not.toContain(credential);
      expect(text).not.toContain(plain.tech_lead!);
      expect(text).not.toContain('"names"');
      expect(text).not.toContain('"tech_lead":{"noticeVersion"');
      const ps = p.c.inbox.find((m) => m.type === "event" && m.event.type === "session.started").event;
      expect(ps).not.toHaveProperty("names");
      expect(Object.keys(ps.consents ?? {})).not.toContain("tech_lead");
    }
  });
});
