import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { expect, vi } from "vitest";
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
import { startServer, type ServerHandle } from "../ws-server.js";
import type { AiRolesDeps } from "../set-ai-roles.js";

// Shared by set-ai-roles.test.ts and set-ai-roles.socket.test.ts (US-0060, Task 7): a real host, real seats, a real server on port 0.
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
export const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
export const NOTICE = { version: "v2", text: "What we record and why." };
export const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];

export type Client = { ws: WebSocket; inbox: any[]; closed: Promise<{ code: number; reason: string }>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
export const track = { server: null as ServerHandle | null, sockets: [] as WebSocket[] };
export async function cleanup() { for (const s of track.sockets) s.terminate(); track.sockets = []; await track.server?.close(); track.server = null; }

export async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  track.sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (c, why) => r({ code: c, reason: why.toString() })));
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

/** `persistFails` / `codesFail` make the fakes throw while true. `files` records what the fake disk holds: codes bytes and the AI-role bytes seats.persist last wrote. */
export async function setup(o: { aiRoles?: string[]; noticeVersion?: string } = {}) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(7_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace(o.aiRoles ?? [], PLAYERS);
  const state = { persistFails: false, codesFail: false, persists: 0, order: [] as string[] };
  const files = { codes: "", aiRoles: JSON.stringify(aiRoles.toRecord(BIND)) };
  const seats: Seats = {
    credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ ...NOTICE, version: o.noticeVersion ?? NOTICE.version }), aiRoles,
    persist: () => { state.persists++; if (state.persistFails) throw new Error("disk full"); files.aiRoles = JSON.stringify(seats.aiRoles!.toRecord(BIND)); },
  };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const issued = JoinCodes.issue(PLAYERS, BIND);
  const joinCodes = new Map<string, JoinCodes>([["local", issued.codes]]);
  const server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes });
  track.server = server;
  let current = issued.codes;
  files.codes = JSON.stringify(current.toRecord());
  const written: JoinCodes[] = [];
  const deps: AiRolesDeps = {
    host, seats, sessionId: "local", server,
    codes: () => current,
    setCodes: (c) => { current = c; server.replaceCodes("local", c); },
    writeCodes: (c) => { if (state.codesFail) throw new Error("codes disk full"); written.push(c); files.codes = JSON.stringify(c.toRecord()); },
  };
  return { port: server.port, server, host, engine, seats, state, files, deps, written, plain: issued.plain, current: () => current };
}
export type Env = Awaited<ReturnType<typeof setup>>;

export async function seat(port: number, roleId: string, code: string, participantId: string, displayName?: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: code, issueCredential: true, ...(displayName !== undefined ? { displayName } : {}) });
  const r = await c.next((m) => m.type === "joined" || m.type === "error");
  return Object.assign(c, { r });
}
export async function consent(c: Client, seats: Seats, roleId: string, participantId: string) {
  c.send({ type: "consent", noticeVersion: seats.consent.notice.version });
  await vi.waitFor(() => expect(seats.consent.has(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
}
export async function facilitator(port: number): Promise<Client> {
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "local" });
  await f.next((m) => m.type === "joined");
  return f;
}
/** Pat joins account_manager and consents. */
export async function pat(e: Env) {
  const p = await seat(e.port, "account_manager", e.plain.account_manager!, "pat", "Pat");
  expect(p.r.type).toBe("joined");
  await consent(p, e.seats, "account_manager", "pat");
  return p;
}
/** All the state a refused or failed switch must leave as it was. */
export const stateOf = (e: Env) => JSON.stringify({
  creds: PLAYERS.map((r) => e.seats.credentials.snapshotRole(r)), consent: e.seats.consent.snapshot(), ai: e.seats.aiRoles!.list(),
  files: e.files, persists: e.state.persists, written: e.written.length, events: e.engine.eventsAfter(0),
});
