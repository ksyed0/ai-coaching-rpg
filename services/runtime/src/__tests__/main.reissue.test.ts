import { mkdtemp, readFile, rm, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../../../../packages/script/src/__tests__/fixtures/minimal");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
let sockets: WebSocket[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of sockets.splice(0)) s.terminate(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent(opts: { failReply?: boolean } = {}) {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = {
    send(m) { if (opts.failReply && (m.type === "reissued" || m.type === "reissue_failed")) return false; sent.push(m); return true; },
    onMessage(fn) { handler = fn; }, onDisconnect() {},
  };
  const ask = async (m: Omit<ParentMessage, "type">) => {
    handler!({ type: "reissue", ...m });
    const reply = () => sent.find((x) => (x.type === "reissued" || x.type === "reissue_failed") && x.requestId === m.requestId);
    await vi.waitFor(() => { if (!reply()) throw new Error("no reply yet"); }, { timeout: 30_000, interval: 10 });
    return reply() as Extract<ChildMessage, { type: "reissued" | "reissue_failed" }>;
  };
  const fire = (m: Omit<ParentMessage, "type">) => handler!({ type: "reissue", ...m });
  return { parent, sent, ask, fire };
}
async function boot(parent: ParentChannel) {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rei-"));
  const data = path.join(tmp, "sessions");
  const logs: string[] = [];
  const r = await bootstrap({
    env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: data },
    root: tmp, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  return { runtime: r.runtime, data, logs };
}
const codeOf = (sent: ChildMessage[]) => (sent.find((m) => m.type === "codes") as Extract<ChildMessage, { type: "codes" }>).codes.find((c) => c.roleId === "host")!.code;
const tryJoin = (port: number, joinCode: string, participantId = "alice") => new Promise<{ type: string; code?: string }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  ws.on("error", reject);
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "joined" || m.type === "error") resolve(m); });
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", sessionId: "p1", roleId: "host", participantId, joinCode })));
});

describe("bootstrap answers reissue over the parent channel (US-0058)", () => {
  it("reissued carries a new code that opens the role; the old one stops working", async () => {
    const { parent, sent, ask } = fakeParent();
    const { runtime } = await boot(parent);
    const first = codeOf(sent);
    const reply = await ask({ requestId: "r1", roleId: "host", by: "Kim" });
    expect(reply.type).toBe("reissued");
    const next = (reply as Extract<ChildMessage, { type: "reissued" }>).code;
    expect(next).not.toBe(first);
    expect((await tryJoin(runtime.port, first)).type).toBe("error");
    expect((await tryJoin(runtime.port, next)).type).toBe("joined");
  });

  it("an unknown or non-player role gets reissue_failed with a fixed reason", async () => {
    const { parent, ask } = fakeParent();
    await boot(parent);
    for (const [i, roleId] of ["nobody", "guest", "facilitator", "__proto__"].entries()) {
      const reply = await ask({ requestId: `r${i}`, roleId });
      expect(reply.type, roleId).toBe("reissue_failed");
      expect((reply as { reason: string }).reason).toBe("not a player role of this session");
    }
  });

  it("a failed codes write leaves the old code working and replies reissue_failed", async () => {
    const { parent, sent, ask } = fakeParent();
    const { runtime, data } = await boot(parent);
    const first = codeOf(sent);
    // Make the atomic write fail: a directory where the codes file must be replaced.
    await rm(path.join(data, "p1.codes.json"));
    await mkdir(path.join(data, "p1.codes.json"));
    const reply = await ask({ requestId: "r1", roleId: "host" });
    expect(reply).toEqual({ type: "reissue_failed", requestId: "r1", reason: "the code could not be reissued" });
    expect(JSON.stringify(reply)).not.toContain(tmp);
    // Nothing was left behind next to it, and the old code (memory still has it) still opens the role.
    expect((await readdir(data)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await tryJoin(runtime.port, first)).type).toBe("joined");
  });

  it("the reissued code is never written to log, warn or the event log", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => { out.push(String(c)); return true; }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => { out.push(String(c)); return true; }) as never);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    const { parent, sent, ask } = fakeParent();
    const { runtime, data, logs } = await boot(parent);
    // After the start, so the alert is appended to the event log too.
    const seats = runtime.host.seats!;
    runtime.host.join("host", "alice");
    seats.credentials.issue("host", "Pat");
    runtime.host.giveConsent("host", "alice", "v1");
    await runtime.host.start();
    const reply = await ask({ requestId: "r1", roleId: "host", by: "Kim" });
    expect(reply.type).toBe("reissued");
    const code = (reply as Extract<ChildMessage, { type: "reissued" }>).code;
    await runtime.host.idle();
    const log = await readFile(path.join(data, "p1.jsonl"), "utf8");
    expect(log).toContain("facilitator.alert");
    const plainForms = [code, code.replace(/-/g, "")];
    const everything = [...logs, ...errs, ...out, log, JSON.stringify(sent.filter((m) => m.type !== "reissued" && m.type !== "codes")), await readFile(path.join(data, "p1.credentials.json"), "utf8"), await readFile(path.join(data, "p1.consent.json"), "utf8"), await readFile(path.join(data, "p1.codes.json"), "utf8")].join("\n");
    for (const f of plainForms) expect(everything).not.toContain(f);
  });

  it("a reply the channel cannot take is warned about without the code, and the handler never throws", async () => {
    const { parent, fire } = fakeParent({ failReply: true });
    const { logs } = await boot(parent);
    expect(() => fire({ requestId: "r1", roleId: "host" })).not.toThrow();
    await vi.waitFor(() => { if (!logs.some((l) => l.includes("could not be handed"))) throw new Error("no warning yet"); }, { timeout: 30_000, interval: 10 });
    expect(logs.join("\n")).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  });
});
