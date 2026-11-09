import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

// US-0060: a lobby whose AI-role file survives a restart on the v1 notice (which does not name AI players) cannot start.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
const consentDir = path.join(here, "../../../../consent"); // holds notice-v1.md and notice-v2.md
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
const sockets: WebSocket[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => { for (const s of sockets.splice(0)) s.terminate(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent() {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
  const ask = async (m: Extract<ParentMessage, { requestId: string }>) => {
    handler!(m);
    const reply = () => sent.find((x) => "requestId" in x && x.requestId === m.requestId);
    await vi.waitFor(() => { if (!reply()) throw new Error("no reply yet"); }, { timeout: 30_000, interval: 10 });
    return reply() as Extract<ChildMessage, { type: "ai_roles_set" | "ai_roles_failed" }>;
  };
  return { parent, sent, ask };
}
async function boot(parent: ParentChannel, notice?: string) {
  const r = await bootstrap({
    env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: path.join(tmp, "sessions"), ...(notice ? { CONSENT_NOTICE_VERSION: notice } : {}) },
    root: tmp, consentDir, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  return r.runtime;
}
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
async function join(port: number, roleId: string, participantId: string, joinCode: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "p1", roleId, participantId, joinCode, issueCredential: true });
  const reply = await c.next((m) => m.type === "joined" || m.type === "error");
  return { c, reply };
}

describe("the AI-notice gate through bootstrap (US-0060)", () => {
  it("a lobby AI-role file restarted on v1 cannot start: start is refused ai_notice with the bot and both humans ready", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-ain-"));
    const a = fakeParent();
    const first = await boot(a.parent); // the default notice (v2) names AI players
    const humanCodes = codesOf(a.sent);
    const set = await a.ask({ type: "set_ai_roles", requestId: "s1", roles: ["tech_lead"] });
    expect(set.type).toBe("ai_roles_set");
    const botCode = (set as Extract<ChildMessage, { type: "ai_roles_set" }>).codes[0]!.code;
    await first.stop(); runtimes.pop();

    const b = fakeParent();
    const second = await boot(b.parent, "v1");
    expect(second.host.seats!.consent.notice.version).toBe("v1");
    expect(second.host.aiRoleIds()).toEqual(["tech_lead"]); // the lobby file was kept
    const am = await join(second.port, "account_manager", "amy", humanCodes.account_manager!);
    const dl = await join(second.port, "delivery_lead", "dan", humanCodes.delivery_lead!);
    for (const [c, role, who] of [[am.c, "account_manager", "amy"], [dl.c, "delivery_lead", "dan"]] as const) {
      c.send({ type: "consent", noticeVersion: "v1" });
      await vi.waitFor(() => expect(second.host.consentGiven(role, who)).toBe(true), { timeout: 30_000, interval: 5 });
    }
    expect((await join(second.port, "tech_lead", "bot1", botCode)).reply.type).toBe("joined");
    const f = await open(second.port);
    f.send({ type: "join_facilitator", sessionId: "p1" });
    await f.next((m) => m.type === "joined");
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toMatchObject({ code: "ai_notice" });
    expect(second.host.hasStarted).toBe(false);
  });
});
