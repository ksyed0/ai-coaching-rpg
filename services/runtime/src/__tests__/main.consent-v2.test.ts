import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

// US-0060 (slice 2b-3a, Task 11): notice v2 is the default and names AI player seats; a restart on it never locks out a started session.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
const consentDir = path.join(here, "../../../../consent"); // holds notice-v1.md and notice-v2.md
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
const sockets: WebSocket[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of sockets.splice(0)) s.terminate(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent() {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
  const ask = async (m: ParentMessage) => {
    handler!(m);
    const reply = () => sent.find((x) => "requestId" in x && x.requestId === m.requestId);
    await vi.waitFor(() => { if (!reply()) throw new Error("no reply yet"); }, { timeout: 30_000, interval: 10 });
    return reply() as Extract<ChildMessage, { type: "ai_roles_set" | "reissued" }>;
  };
  return { parent, sent, ask };
}
/** `notice` pins CONSENT_NOTICE_VERSION; left out, the default applies. */
async function boot(parent: ParentChannel, data: string, notice?: string) {
  if (!tmp) tmp = await mkdtemp(path.join(os.tmpdir(), "acr-cv2-"));
  const r = await bootstrap({
    env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: data, ...(notice ? { CONSENT_NOTICE_VERSION: notice } : {}) },
    root: tmp, consentDir, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  return r.runtime;
}
const dataDir = () => path.join(tmp, "sessions");
const codesOf = (sent: ChildMessage[]) => Object.fromEntries((sent.find((m) => m.type === "codes") as Extract<ChildMessage, { type: "codes" }>).codes.map((c) => [c.roleId, c.code]));

type Client = { inbox: any[]; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)) };
}
const answer = (c: Client) => c.next((m) => m.type === "joined" || m.type === "error");
async function join(port: number, roleId: string, participantId: string, how: { joinCode: string } | { credential: string }) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "p1", roleId, participantId, issueCredential: "joinCode" in how, ...how });
  return { c, reply: await answer(c) };
}
async function facilitator(port: number) {
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "p1" });
  await f.next((m) => m.type === "joined");
  return f;
}
async function consent(c: Client, runtime: Runtime, roleId: string, participantId: string, version: string) {
  c.send({ type: "consent", noticeVersion: version });
  await vi.waitFor(() => expect(runtime.host.consentGiven(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
}

describe("consent notice v2 (US-0060)", () => {
  it('without CONSENT_NOTICE_VERSION a player\'s joined offers v2, whose text contains "named “AI player”"', async () => {
    const a = fakeParent();
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-cv2-"));
    const runtime = await boot(a.parent, dataDir());
    const { reply } = await join(runtime.port, "account_manager", "amy", { joinCode: codesOf(a.sent).account_manager! });
    expect(reply.type).toBe("joined");
    expect(reply.consent.noticeVersion).toBe("v2");
    expect(reply.consent.notice).toContain("named “AI player”");
  });

  it("notice-v1.md still has sha256 7dde9e1e98d74b1f7b5943f96e6b808aad074d154e50b8224ee66d6f026b2b09", async () => {
    const bytes = await readFile(path.join(consentDir, "notice-v1.md"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("7dde9e1e98d74b1f7b5943f96e6b808aad074d154e50b8224ee66d6f026b2b09");
  });

  it('a started session whose players consented under v1 restarts on v2: both humans rejoin with their credentials, a different participant for account_manager is refused consent_required, a bot rejoins tech_lead with a reissued code, and the log still starts with logFormat 3 and aiRoles ["tech_lead"]', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-cv2-"));
    const a = fakeParent();
    const first = await boot(a.parent, dataDir(), "v1");
    const humanCodes = codesOf(a.sent);
    const set = await a.ask({ type: "set_ai_roles", requestId: "s1", roles: ["tech_lead"] });
    expect(set.type).toBe("ai_roles_set");
    const botCode = (set as Extract<ChildMessage, { type: "ai_roles_set" }>).codes[0]!.code;
    const am = await join(first.port, "account_manager", "amy", { joinCode: humanCodes.account_manager! });
    const dl = await join(first.port, "delivery_lead", "dan", { joinCode: humanCodes.delivery_lead! });
    await join(first.port, "tech_lead", "bot1", { joinCode: botCode });
    expect(am.reply.consent.noticeVersion).toBe("v1");
    await consent(am.c, first, "account_manager", "amy", "v1");
    await consent(dl.c, first, "delivery_lead", "dan", "v1");
    const f = await facilitator(first.port);
    f.send({ type: "start" });
    await f.next((m) => m.type === "event" && m.event?.type === "scene.entered");
    const credentials = { account_manager: am.reply.credential as string, delivery_lead: dl.reply.credential as string };
    expect(credentials.account_manager).toBeTruthy();
    await first.stop(); runtimes.pop();

    const b = fakeParent();
    const second = await boot(b.parent, dataDir()); // the default: v2
    expect(second.host.seats!.consent.notice.version).toBe("v2");
    const amy = await join(second.port, "account_manager", "amy", { credential: credentials.account_manager });
    const dan = await join(second.port, "delivery_lead", "dan", { credential: credentials.delivery_lead });
    expect(amy.reply.type).toBe("joined");
    expect(dan.reply.type).toBe("joined");
    expect(amy.reply.consent).toMatchObject({ noticeVersion: "v2", given: true }); // the log's consent stands under the new notice
    const other = await join(second.port, "account_manager", "mallory", { credential: credentials.account_manager });
    expect(other.reply).toMatchObject({ type: "error", code: "consent_required" });
    const re = await b.ask({ type: "reissue", requestId: "r1", roleId: "tech_lead" });
    expect(re.type).toBe("reissued");
    const bot = await join(second.port, "tech_lead", "bot2", { joinCode: (re as Extract<ChildMessage, { type: "reissued" }>).code });
    expect(bot.reply.type).toBe("joined");
    expect(second.host.aiRoleIds()).toEqual(["tech_lead"]);
    const firstLine = JSON.parse((await readFile(path.join(dataDir(), "p1.jsonl"), "utf8")).split("\n")[0]!);
    expect(firstLine).toMatchObject({ type: "session.started", logFormat: 3, aiRoles: ["tech_lead"] });
  });

  it('a lobby whose players consented under v1 restarts on v2: seats and the AI role are kept, the v1 consents are dropped, and start is refused "seats_not_ready: account_manager,delivery_lead"', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-cv2-"));
    const a = fakeParent();
    const first = await boot(a.parent, dataDir(), "v1");
    const humanCodes = codesOf(a.sent);
    const set = await a.ask({ type: "set_ai_roles", requestId: "s1", roles: ["tech_lead"] });
    const botCode = (set as Extract<ChildMessage, { type: "ai_roles_set" }>).codes[0]!.code;
    const am = await join(first.port, "account_manager", "amy", { joinCode: humanCodes.account_manager! });
    const dl = await join(first.port, "delivery_lead", "dan", { joinCode: humanCodes.delivery_lead! });
    await consent(am.c, first, "account_manager", "amy", "v1");
    await consent(dl.c, first, "delivery_lead", "dan", "v1");
    await first.stop(); runtimes.pop();

    const b = fakeParent();
    const second = await boot(b.parent, dataDir());
    const seats = second.host.seats!;
    expect(seats.consent.notice.version).toBe("v2");
    expect(seats.credentials.has("account_manager")).toBe(true);
    expect(seats.credentials.has("delivery_lead")).toBe(true);
    expect(second.host.aiRoleIds()).toEqual(["tech_lead"]);
    expect(seats.consent.hasEntry("account_manager")).toBe(false);
    expect(seats.consent.hasEntry("delivery_lead")).toBe(false);
    const bot = await join(second.port, "tech_lead", "bot1", { joinCode: botCode });
    expect(bot.reply.type).toBe("joined");
    const f = await facilitator(second.port);
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toMatchObject({ code: "seats_not_ready", message: "seats_not_ready: account_manager,delivery_lead" });
    expect(second.host.hasStarted).toBe(false);
  });
});
