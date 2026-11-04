import { mkdtemp, rm, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";
import { AI_ROLES_REFUSED } from "../host/set-ai-roles.js";

// Only the "no join codes" test strips them: the real openSession always issues codes for a scenario with player roles.
let stripCodes = false;
vi.mock("../engine/session-store.js", async (orig) => {
  const real = await orig<typeof import("../engine/session-store.js")>();
  return { ...real, openSession: async (o: Parameters<typeof real.openSession>[0]) => { const s = await real.openSession(o); return stripCodes ? { ...s, joinCodes: undefined } : s; } };
});

// US-0060 (slice 2b-3a, Task 8): set_ai_roles over the parent channel, on the friday-escalation scenario.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
let sockets: WebSocket[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => { stripCodes = false; vi.restoreAllMocks(); for (const s of sockets.splice(0)) s.terminate(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

type Reply = Extract<ChildMessage, { type: "ai_roles_set" | "ai_roles_failed" | "reissued" | "reissue_failed" }>;
function fakeParent() {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
  const ask = async (m: Exclude<ParentMessage, { type: "bot_alert" }>) => {
    handler!(m);
    const reply = () => sent.find((x) => "requestId" in x && x.requestId === m.requestId);
    await vi.waitFor(() => { if (!reply()) throw new Error("no reply yet"); }, { timeout: 30_000, interval: 10 });
    return reply() as Reply;
  };
  const setRoles = (requestId: string, roles: string[]) => ask({ type: "set_ai_roles", requestId, roles });
  return { parent, sent, ask, setRoles };
}
async function boot(parent: ParentChannel, o: { scenario?: string; data?: string } = {}) {
  if (!tmp) tmp = await mkdtemp(path.join(os.tmpdir(), "acr-air-"));
  const data = o.data ?? path.join(tmp, "sessions");
  const logs: string[] = [];
  const r = await bootstrap({
    env: { SCENARIO_DIR: o.scenario ?? friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: data },
    root: tmp, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  return { runtime: r.runtime, data, logs };
}
const codesOf = (sent: ChildMessage[]) => Object.fromEntries((sent.find((m) => m.type === "codes") as Extract<ChildMessage, { type: "codes" }>).codes.map((c) => [c.roleId, c.code]));
const tryJoin = (port: number, roleId: string, joinCode: string) => new Promise<{ type: string }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  ws.on("error", reject);
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "joined" || m.type === "error") resolve(m); });
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", sessionId: "p1", roleId, participantId: "alice", joinCode })));
});
const readyOf = (sent: ChildMessage[]) => sent.filter((m) => m.type === "ready").at(-1) as Extract<ChildMessage, { type: "ready" }>;

describe("bootstrap answers set_ai_roles over the parent channel (US-0060)", () => {
  it('set_ai_roles ["tech_lead"] answers ai_roles_set with one code that opens tech_lead, and the code issued at create is refused', async () => {
    const { parent, sent, setRoles } = fakeParent();
    const { runtime } = await boot(parent);
    const first = codesOf(sent).tech_lead!;
    const reply = await setRoles("a1", ["tech_lead"]);
    expect(reply.type).toBe("ai_roles_set");
    const codes = (reply as Extract<ChildMessage, { type: "ai_roles_set" }>).codes;
    expect(codes).toHaveLength(1);
    expect(codes[0]!.roleId).toBe("tech_lead");
    expect(codes[0]!.code).not.toBe(first);
    expect((await tryJoin(runtime.port, "tech_lead", first)).type).toBe("error");
    expect((await tryJoin(runtime.port, "tech_lead", codes[0]!.code)).type).toBe("joined");
    expect(runtime.host.aiRoleIds()).toEqual(["tech_lead"]);
  });

  it("a refused set_ai_roles answers ai_roles_failed with the fixed reason, never a path or a role id", async () => {
    const { parent, setRoles } = fakeParent();
    await boot(parent);
    const bad = await setRoles("a1", ["account_manager", "delivery_lead", "tech_lead"]);
    expect(bad).toEqual({ type: "ai_roles_failed", requestId: "a1", reason: AI_ROLES_REFUSED.noHuman });
    const unknown = await setRoles("a2", ["nobody"]);
    expect(unknown).toEqual({ type: "ai_roles_failed", requestId: "a2", reason: AI_ROLES_REFUSED.invalid });
    for (const r of [bad, unknown]) { expect(JSON.stringify(r)).not.toContain(tmp); expect(JSON.stringify(r)).not.toContain("tech_lead"); }
  });

  it("an error that is not a refusal answers with the failed reason only: no path, no role id, no message", async () => {
    const { parent, sent, setRoles } = fakeParent();
    const { data } = await boot(parent);
    // A directory where the codes file must be replaced makes the first write fail with an error whose message holds the path.
    await rm(path.join(data, "p1.codes.json"));
    await mkdir(path.join(data, "p1.codes.json"));
    const reply = await setRoles("a1", ["tech_lead"]);
    expect(reply).toEqual({ type: "ai_roles_failed", requestId: "a1", reason: AI_ROLES_REFUSED.failed });
    expect(JSON.stringify(sent)).not.toContain(tmp);
    expect(JSON.stringify(reply)).not.toContain("tech_lead");
  });

  it("a thrown error carrying a path and a role id never reaches the reply (the synchronous catch and the async rejection)", async () => {
    const { parent, sent, setRoles, ask } = fakeParent();
    const { runtime } = await boot(parent);
    const boom = () => { throw new Error("EACCES: /secret/dir/p1.ai-roles.json for role tech_lead"); };
    vi.spyOn(runtime.host, "hasPlayerRole").mockImplementation(boom);
    const reply = await setRoles("a1", ["tech_lead"]);
    expect(reply).toEqual({ type: "ai_roles_failed", requestId: "a1", reason: AI_ROLES_REFUSED.failed });
    const text = JSON.stringify(sent);
    expect(text).not.toContain("/secret");
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("ai-roles.json");
    // The synchronous catch follows the message's own type: a throwing reissue still answers reissue_failed.
    const re = await ask({ type: "reissue", requestId: "r1", roleId: "tech_lead" });
    expect(re).toEqual({ type: "reissue_failed", requestId: "r1", reason: "the code could not be reissued" });
  });

  it("a managed restart of the lobby sends ready with aiRoles [\"tech_lead\"]; a session without AI roles sends ready without the key", async () => {
    const a = fakeParent();
    const first = await boot(a.parent);
    expect("aiRoles" in readyOf(a.sent)).toBe(false);
    expect((await a.setRoles("a1", ["tech_lead"])).type).toBe("ai_roles_set");
    await first.runtime.stop(); runtimes.pop();
    const b = fakeParent();
    await boot(b.parent, { data: first.data });
    expect(readyOf(b.sent).aiRoles).toEqual(["tech_lead"]);
    expect((await b.setRoles("a2", [])).type).toBe("ai_roles_set");
    const c = fakeParent();
    await runtimes.pop()!.stop();
    await boot(c.parent, { data: first.data });
    expect("aiRoles" in readyOf(c.sent)).toBe(false);
  });

  it("a resumed started session sends ready with aiRoles from its log after the AI-role file was deleted", async () => {
    const a = fakeParent();
    const first = await boot(a.parent);
    expect((await a.setRoles("a1", ["tech_lead"])).type).toBe("ai_roles_set");
    const host = first.runtime.host;
    const seats = host.seats!;
    for (const [role, who, name] of [["account_manager", "amy", "Amy"], ["delivery_lead", "dan", "Dan"], ["tech_lead", "bot", "AI player"]] as const) {
      host.join(role, who);
      seats.credentials.issue(role, name);
      if (role !== "tech_lead") host.giveConsent(role, who, seats.consent.notice.version);
    }
    await host.start();
    await host.idle();
    await first.runtime.stop(); runtimes.pop();
    await unlink(path.join(first.data, "p1.ai-roles.json"));
    const b = fakeParent();
    await boot(b.parent, { data: first.data });
    const ready = readyOf(b.sent);
    expect(ready.status).toBe("resumed");
    expect(ready.aiRoles).toEqual(["tech_lead"]);
  });

  it("BUG-0021: a managed restart that issues fresh codes sends ready with aiRolesReset; a restart that keeps the codes sends neither the key nor loses the roles", async () => {
    const a = fakeParent();
    const first = await boot(a.parent);
    expect((await a.setRoles("a1", ["tech_lead"])).type).toBe("ai_roles_set");
    await first.runtime.stop(); runtimes.pop();
    const kept = fakeParent();
    const second = await boot(kept.parent, { data: first.data });
    expect("aiRolesReset" in readyOf(kept.sent)).toBe(false);
    expect(readyOf(kept.sent).aiRoles).toEqual(["tech_lead"]);
    await second.runtime.stop(); runtimes.pop();
    await unlink(path.join(first.data, "p1.codes.json"));
    const fresh = fakeParent();
    await boot(fresh.parent, { data: first.data });
    const ready = readyOf(fresh.sent);
    expect(ready.aiRolesReset).toEqual(["tech_lead"]);
    expect("aiRoles" in ready).toBe(false); // the file went with the old seats: the roles are human again until the parent re-sends them
    expect(JSON.stringify(ready)).not.toMatch(/code/i);
  });

  it("a reissue still answers reissued as before", async () => {
    const { parent, sent, ask } = fakeParent();
    const { runtime } = await boot(parent);
    const first = codesOf(sent).tech_lead!;
    const reply = await ask({ type: "reissue", requestId: "r1", roleId: "tech_lead" });
    expect(reply.type).toBe("reissued");
    const next = (reply as Extract<ChildMessage, { type: "reissued" }>).code;
    expect((await tryJoin(runtime.port, "tech_lead", first)).type).toBe("error");
    expect((await tryJoin(runtime.port, "tech_lead", next)).type).toBe("joined");
  });

  it('set_ai_roles to a session without join codes answers ai_roles_failed "the AI roles could not be changed"', async () => {
    // The guard (no join codes or seats) must answer with the AI-role failure type, never reissue_failed.
    stripCodes = true;
    const { parent, sent, setRoles } = fakeParent();
    await boot(parent);
    const reply = await setRoles("a1", ["tech_lead"]);
    expect(reply).toEqual({ type: "ai_roles_failed", requestId: "a1", reason: "the AI roles could not be changed" });
    expect(sent.some((m) => m.type === "reissue_failed")).toBe(false);
  });
});
