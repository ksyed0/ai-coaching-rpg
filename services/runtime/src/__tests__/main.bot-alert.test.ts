import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

// US-0060 (slice 2b-3b, Task 5): bot_alert (fire-and-forget) and ready.aiCalls over the parent channel, on friday-escalation.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
let sockets: WebSocket[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of sockets.splice(0)) s.terminate(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent() {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
  return { parent, sent, tell: (m: ParentMessage) => handler!(m), ask: (m: ParentMessage) => handler!(m) };
}
async function boot(parent: ParentChannel, data?: string) {
  if (!tmp) tmp = await mkdtemp(path.join(os.tmpdir(), "acr-bota-"));
  const dir = data ?? path.join(tmp, "sessions");
  const r = await bootstrap({
    env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: dir },
    root: tmp, tickMs: 60_000, log: () => undefined, warn: () => undefined, parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  return { runtime: r.runtime, data: dir };
}
const codesOf = (sent: ChildMessage[]) => Object.fromEntries((sent.find((m) => m.type === "codes") as Extract<ChildMessage, { type: "codes" }>).codes.map((c) => [c.roleId, c.code]));
const readyOf = (sent: ChildMessage[]) => sent.filter((m) => m.type === "ready").at(-1) as Extract<ChildMessage, { type: "ready" }>;
const alertsOf = async (data: string): Promise<{ type: string; level?: string; message?: string }[]> =>
  (await readFile(path.join(data, "p1.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "facilitator.alert");
const MSG = "skipped a turn: the model did not answer";
const botAlert = (roleId: string, message: string): ParentMessage => ({ type: "bot_alert", roleId, message });

/** Sets tech_lead to an AI, seats everybody and starts the session; returns a real player socket on account_manager that records every frame. */
async function startWithAi(b: ReturnType<typeof fakeParent>, runtime: Runtime, codes: Record<string, string>) {
  b.ask({ type: "set_ai_roles", requestId: "a1", roles: ["tech_lead"] });
  await vi.waitFor(() => { expect(b.sent.some((m) => m.type === "ai_roles_set")).toBe(true); }, { timeout: 30_000, interval: 10 });
  const host = runtime.host;
  const seats = host.seats!;
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}`);
  sockets.push(ws);
  ws.on("message", (d) => frames.push(d.toString()));
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "join", sessionId: "p1", roleId: "account_manager", participantId: "amy", joinCode: codes.account_manager }));
  await vi.waitFor(() => expect(frames.some((f) => JSON.parse(f).type === "joined")).toBe(true), { timeout: 30_000, interval: 10 });
  host.giveConsent("account_manager", "amy", seats.consent.notice.version);
  for (const [role, who] of [["delivery_lead", "dan"], ["tech_lead", "bot"]] as const) {
    host.join(role, who);
    seats.credentials.issue(role, role === "tech_lead" ? "AI player" : "Dan");
    if (role !== "tech_lead") host.giveConsent(role, who, seats.consent.notice.version);
  }
  return { host, frames };
}

describe("bot_alert over the parent channel (US-0060)", () => {
  it('bot_alert for tech_lead after the start appends one facilitator.alert warning "AI player for tech_lead: ..." that no player socket receives', async () => {
    const b = fakeParent();
    const { runtime, data } = await boot(b.parent);
    const { host, frames } = await startWithAi(b, runtime, codesOf(b.sent));
    await host.start();
    await host.idle();
    b.tell(botAlert("tech_lead", MSG));
    await vi.waitFor(async () => expect((await alertsOf(data)).filter((a) => a.message === `AI player for tech_lead: ${MSG}`)).toHaveLength(1), { timeout: 30_000, interval: 20 });
    const mine = (await alertsOf(data)).filter((a) => a.message?.startsWith("AI player for"));
    expect(mine).toEqual([expect.objectContaining({ type: "facilitator.alert", level: "warning", message: `AI player for tech_lead: ${MSG}` })]);
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.length).toBeGreaterThan(1); // the socket is live and receiving
    expect(frames.join("\n")).not.toContain("AI player for");
    expect(frames.join("\n")).not.toContain(MSG);
  });

  it("bot_alert before the start appends nothing (the log stays empty and start still succeeds)", async () => {
    const b = fakeParent();
    const { runtime, data } = await boot(b.parent);
    const { host } = await startWithAi(b, runtime, codesOf(b.sent));
    b.tell(botAlert("tech_lead", MSG));
    await host.botAlert("tech_lead", MSG);
    expect(await readFile(path.join(data, "p1.jsonl"), "utf8").catch(() => "")).toBe("");
    await host.start();
    await host.idle();
    expect((await alertsOf(data)).filter((a) => a.message?.startsWith("AI player for"))).toEqual([]);
  });

  it("bot_alert for account_manager (human) or after the end appends nothing", async () => {
    const b = fakeParent();
    const { runtime, data } = await boot(b.parent);
    const { host } = await startWithAi(b, runtime, codesOf(b.sent));
    await host.start();
    await host.idle();
    await host.botAlert("account_manager", MSG);
    await host.botAlert("client_sponsor", MSG); // an AI character is no AI player
    await host.botAlert("ghost", MSG);
    await host.endNow({ by: "tester" });
    await host.idle();
    const before = (await alertsOf(data)).length;
    await host.botAlert("tech_lead", MSG);
    const after = await alertsOf(data);
    expect(after).toHaveLength(before);
    expect(after.filter((a) => a.message?.startsWith("AI player for"))).toEqual([]);
  });

  it('a message with "\\u001b[31m" and a bidi override is stripped before it is recorded', async () => {
    const b = fakeParent();
    const { runtime, data } = await boot(b.parent);
    const { host } = await startWithAi(b, runtime, codesOf(b.sent));
    await host.start();
    await host.idle();
    b.tell(botAlert("tech_lead", "\u001b[31mskipped‮ a  turn\u0007\n\tnow"));
    await vi.waitFor(async () => expect((await alertsOf(data)).some((a) => a.message?.startsWith("AI player for"))).toBe(true), { timeout: 30_000, interval: 20 });
    const msg = (await alertsOf(data)).find((a) => a.message?.startsWith("AI player for"))!.message!;
    expect(msg).toBe("AI player for tech_lead: skipped a turn now");
  });

  it("a message longer than 200 code points after cleaning is cut to 200 code points; one empty after cleaning appends nothing", async () => {
    const b = fakeParent();
    const { runtime, data } = await boot(b.parent);
    const { host } = await startWithAi(b, runtime, codesOf(b.sent));
    await host.start();
    await host.idle();
    await host.botAlert("tech_lead", "‮\u0007  \n ");
    await host.botAlert("tech_lead", "\u{1F600}".repeat(150) + "   " + "x".repeat(100));
    const got = (await alertsOf(data)).filter((a) => a.message?.startsWith("AI player for"));
    expect(got).toHaveLength(1);
    const body = got[0]!.message!.slice("AI player for tech_lead: ".length);
    expect(Array.from(body)).toHaveLength(200);
  });

  it("bot_alert gets no reply on the channel, and a throwing botAlert (sync or async) sends nothing either", async () => {
    const b = fakeParent();
    const { runtime } = await boot(b.parent);
    const { host } = await startWithAi(b, runtime, codesOf(b.sent));
    await host.start();
    await host.idle();
    const n = b.sent.length;
    b.tell(botAlert("tech_lead", MSG));
    vi.spyOn(host, "botAlert").mockImplementation(() => { throw new Error("EACCES: /secret/dir"); });
    b.tell(botAlert("tech_lead", MSG));
    vi.spyOn(host, "botAlert").mockImplementation(() => Promise.reject(new Error("EACCES: /secret/dir")));
    b.tell(botAlert("tech_lead", MSG));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.sent.slice(n)).toEqual([]);
  });

  it("bot_alert in the lobby is dropped with no reply of any type", async () => {
    const b = fakeParent();
    await boot(b.parent);
    const n = b.sent.length;
    b.tell(botAlert("tech_lead", MSG)); // the lobby: nothing appended, nothing answered
    await new Promise((r) => setTimeout(r, 100));
    expect(b.sent.slice(n)).toEqual([]);
  });
});

describe("ready.aiCalls over the parent channel (US-0060)", () => {
  it("a resumed format-3 log with three tech_lead lines and two account_manager lines sends ready with aiCalls 3", async () => {
    const a = fakeParent();
    const first = await boot(a.parent);
    const { host } = await startWithAi(a, first.runtime, codesOf(a.sent));
    await host.start();
    await host.idle();
    for (const [role, text] of [["tech_lead", "t1"], ["account_manager", "a1"], ["tech_lead", "t2"], ["account_manager", "a2"], ["tech_lead", "t3"]] as const) await host.engine.say(role, text);
    await first.runtime.stop(); runtimes.pop();
    const b = fakeParent();
    await boot(b.parent, first.data);
    const ready = readyOf(b.sent);
    expect(ready.status).toBe("resumed");
    expect(ready.aiRoles).toEqual(["tech_lead"]);
    expect(ready.aiCalls).toBe(3);
  });

  it("a lobby restart sends ready without aiCalls, and so does a resumed session with no AI roles", async () => {
    const a = fakeParent();
    const first = await boot(a.parent);
    expect("aiCalls" in readyOf(a.sent)).toBe(false);
    await first.runtime.stop(); runtimes.pop();
    const b = fakeParent();
    await boot(b.parent, first.data);
    expect(readyOf(b.sent).status).toBe("new");
    expect("aiCalls" in readyOf(b.sent)).toBe(false);
  });
});
