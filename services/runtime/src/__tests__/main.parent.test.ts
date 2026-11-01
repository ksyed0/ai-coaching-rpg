import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FATAL_HARD_EXIT_MS, bootstrap, watchParent, type Runtime } from "../main.js";
import { SessionHost } from "../host/session-host.js";
import { JsonlEventLog } from "../engine/event-log.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../../../../packages/script/src/__tests__/fixtures/minimal");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
const runtimes: Runtime[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent(opts: { failOn?: ChildMessage["type"] } = {}) {
  const sent: ChildMessage[] = [];
  const handlers: ((m: ParentMessage) => void)[] = [];
  const parent: ParentChannel = {
    send(m) { if (m.type === opts.failOn) return false; sent.push(m); return true; },
    onMessage(fn) { handlers.push(fn); }, onDisconnect() {},
  };
  return { parent, sent, ask: (m: ParentMessage) => { for (const h of handlers) h(m); } };
}
async function boot(parent: ParentChannel | undefined, data: string, extra: Record<string, string> = {}) {
  const logs: string[] = [];
  const r = await bootstrap({
    env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: data, ...extra },
    root: tmp, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), ...(parent ? { parent } : {}),
  });
  if (r.ok) runtimes.push(r.runtime);
  return { r, logs };
}
const mk = async () => { tmp = await mkdtemp(path.join(os.tmpdir(), "acr-par-")); return path.join(tmp, "sessions"); };

describe("bootstrap with a parent channel (US-0058)", () => {
  it("a new start sends codes then ready, in that order, codes only when issued", async () => {
    const data = await mk();
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(sent.map((m) => m.type)).toEqual(["codes", "ready"]);
    const codes = sent[0] as Extract<ChildMessage, { type: "codes" }>;
    expect(codes.codes.length).toBeGreaterThan(0);
    for (const c of codes.codes) expect(c.code.length).toBeGreaterThan(0);
    const ready = sent[1] as Extract<ChildMessage, { type: "ready" }>;
    expect(ready.port).toBe(r.runtime.port);
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.status).toBe("new");
    expect(ready.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(ready.modelLabel.length).toBeGreaterThan(0);
  });

  it("an empty-lobby restart keeps its codes: ready with status new and no codes", async () => {
    const data = await mk();
    const first = await boot(fakeParent().parent, data);
    if (!first.r.ok) throw new Error(first.r.errors.join("; "));
    await first.r.runtime.stop(); runtimes.pop();
    const { parent, sent } = fakeParent();
    const second = await boot(parent, data);
    if (!second.r.ok) throw new Error(second.r.errors.join("; "));
    expect(sent.map((m) => m.type)).toEqual(["ready"]);
    expect((sent[0] as Extract<ChildMessage, { type: "ready" }>).status).toBe("new");
  });

  it("a resumed start sends ready with status resumed and no codes", async () => {
    const data = await mk();
    const firstParent = fakeParent();
    const first = await boot(firstParent.parent, data);
    if (!first.r.ok) throw new Error(first.r.errors.join("; "));
    const hostCode = (firstParent.sent[0] as Extract<ChildMessage, { type: "codes" }>).codes.find((c) => c.roleId === "host")!.code;
    // Produce a non-empty log: seat and consent the player, then start the session over the real socket path.
    const inbox: { type: string; code?: string; event?: { type: string } }[] = [];
    const wait = async (pred: (m: (typeof inbox)[number]) => boolean) => vi.waitFor(() => { if (!inbox.some(pred)) throw new Error("not yet"); }, { timeout: 30_000, interval: 20 });
    const open = (port: number) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("message", (d) => inbox.push(JSON.parse(d.toString()))); w.on("open", () => res(w)); w.on("error", rej); });
    const fac = await open(first.r.runtime.port);
    const player = await open(first.r.runtime.port);
    try {
      fac.send(JSON.stringify({ type: "join_facilitator", sessionId: "p1" }));
      player.send(JSON.stringify({ type: "join", sessionId: "p1", roleId: "host", participantId: "alice", joinCode: hostCode }));
      await wait((m) => m.type === "joined");
      player.send(JSON.stringify({ type: "consent", noticeVersion: "v1" }));
      player.send(JSON.stringify({ type: "say", text: "settle" }));
      await wait((m) => m.type === "error" && m.code === "not_started");
      fac.send(JSON.stringify({ type: "start" }));
      await wait((m) => m.type === "event" && m.event?.type === "scene.entered");
    } finally { fac.close(); player.close(); }
    await first.r.runtime.stop(); runtimes.pop();

    const { parent, sent } = fakeParent();
    const second = await boot(parent, data);
    if (!second.r.ok) throw new Error(second.r.errors.join("; "));
    expect(sent.map((m) => m.type)).toEqual(["ready"]); // no codes: the ones issued earlier still apply
    const ready = sent[0] as Extract<ChildMessage, { type: "ready" }>;
    expect(ready.status).toBe("resumed");
    expect(ready.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(ready.logIdentity!.length).toBeLessThanOrEqual(200);
  });

  it("a failed codes send aborts the start and the issued codes are withdrawn (the .codes.json is removed)", async () => {
    const data = await mk();
    const { parent, sent } = fakeParent({ failOn: "codes" });
    const { r } = await boot(parent, data);
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]); // no ready after a failed codes send
    expect(existsSync(path.join(data, "p1.codes.json"))).toBe(false);
  });

  it("a failed ready send fails the start without leaking codes into logs", async () => {
    const data = await mk();
    const { parent, sent } = fakeParent({ failOn: "ready" });
    const { r, logs } = await boot(parent, data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(sent.map((m) => m.type)).toEqual(["codes"]);
    const codes = (sent[0] as Extract<ChildMessage, { type: "codes" }>).codes;
    const everything = [...logs, ...r.errors].join("\n");
    for (const c of codes) expect(everything).not.toContain(c.code);
    // The codes were already handed over, so they are not withdrawn: the parent reissues.
    expect(existsSync(path.join(data, "p1.codes.json"))).toBe(true);
    // Nothing is left running: the lock is released so the same session can start again.
    const again = await boot(fakeParent().parent, data);
    expect(again.r.ok).toBe(true);
  });

  /** BUG-0016: a first life that holds a credential, is started and sits in the LAST scene; the log is then cut right after that scene's exit. */
  async function cutAfterLastSceneExit(data: string, cut: boolean, how: "advance" | "end_now" = "advance") {
    const first = await boot(fakeParent().parent, data);
    if (!first.r.ok) throw new Error(first.r.errors.join("; "));
    const h = first.r.runtime.host;
    h.join("host", "alice");
    h.seats!.credentials.issue("host", "Pat");
    h.giveConsent("host", "alice", "v1");
    await h.start();
    await h.engine.command({ command: "advance" });
    await h.engine.tick(); // now in the last scene (s2_close)
    h.seats!.persist();
    await h.idle();
    await first.r.runtime.stop(); runtimes.pop();
    if (cut) {
      const log = new JsonlEventLog("p1", data, { sync: false });
      if (how === "end_now") {
        // end_now appends scene.exited, then the alert, then session.ended: the log is cut before the last of the three.
        await log.append({ type: "scene.exited", sceneId: "s2_close", reason: "facilitator_end" }, Date.now());
        await log.append({ type: "facilitator.alert", level: "warning", message: "Sam ended the session" }, Date.now());
      } else await log.append({ type: "scene.exited", sceneId: "s2_close", reason: "facilitator_advance" }, Date.now());
      await log.close();
    }
  }

  it("a resume whose repair ended the session (log cut after the last scene's exit, script_complete repair) sends ready then ended, and every credential is revoked", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, true);
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.runtime.host.engine.state.status).toBe("ended");
    expect(sent.map((m) => m.type)).toEqual(["ready", "ended"]);
    expect((sent[0] as Extract<ChildMessage, { type: "ready" }>).status).toBe("resumed");
    const seats = r.runtime.host.seats!;
    expect(seats.credentials.ended).toBe(true);
    expect(seats.credentials.has("host")).toBe(false);
  });

  it("a log cut after the end_now alert (no session.ended) resumes to ready then ended, and every credential is revoked", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, true, "end_now");
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.runtime.host.engine.state.status).toBe("ended");
    expect(sent.map((m) => m.type)).toEqual(["ready", "ended"]);
    expect((sent[0] as Extract<ChildMessage, { type: "ready" }>).status).toBe("resumed");
    const seats = r.runtime.host.seats!;
    expect(seats.credentials.ended).toBe(true);
    expect(seats.credentials.has("host")).toBe(false);
  });

  it("the revoke is persisted: the credentials file carries the end mark and no role after a repaired-to-ended resume", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, true);
    const { r } = await boot(fakeParent().parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const files = (await readdir(data)).filter((f) => f.startsWith("p1.") && f.endsWith(".json") && !f.includes("codes"));
    const texts = await Promise.all(files.map((f) => readFile(path.join(data, f), "utf8")));
    const cred = texts.find((t) => t.includes('"ended"') && t.includes("salt"));
    expect(cred).toBeDefined();
    expect(JSON.parse(cred!)).toMatchObject({ ended: true, roles: {} });
  });

  it("an endSeats that throws is reported and the start still succeeds with ready then ended", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, true);
    vi.spyOn(SessionHost.prototype, "endSeats").mockImplementation(() => { throw new Error("disk full /secret/path"); });
    const { parent, sent } = fakeParent();
    const { r, logs } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(sent.map((m) => m.type)).toEqual(["ready", "ended"]);
    expect(logs.some((l) => l.includes("end of session revoke: Error"))).toBe(true);
    expect(logs.join("\n")).not.toContain("/secret/path");
  });

  it("a standalone (no parent) resume repaired to ended also revokes every credential", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, true);
    const { r } = await boot(undefined, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.runtime.host.engine.state.status).toBe("ended");
    expect(r.runtime.host.seats!.credentials.ended).toBe(true);
    expect(r.runtime.host.seats!.credentials.has("host")).toBe(false);
  });

  it("a normal resume sends ready and no ended", async () => {
    const data = await mk();
    await cutAfterLastSceneExit(data, false);
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.runtime.host.engine.state.status).toBe("running");
    expect(sent.map((m) => m.type)).toEqual(["ready"]);
    expect(r.runtime.host.seats!.credentials.ended).toBe(false);
  });

  it("session.ended sends ended once", async () => {
    const data = await mk();
    const subs: ((e: { type: string }) => void)[] = [];
    const orig = SessionHost.prototype.subscribe;
    vi.spyOn(SessionHost.prototype, "subscribe").mockImplementation(function (this: SessionHost, fn) { subs.push(fn as never); return orig.call(this, fn); });
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(sent.some((m) => m.type === "ended")).toBe(false);
    for (const s of subs) { s({ type: "session.ended" }); s({ type: "session.ended" }); }
    expect(sent.filter((m) => m.type === "ended")).toHaveLength(1);
    expect(sent[sent.length - 1]!.type).toBe("ended");
  });

  it("end_now sends ended once", async () => {
    const data = await mk();
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const h = r.runtime.host;
    h.join("host", "alice");
    h.seats!.credentials.issue("host", "Pat");
    h.giveConsent("host", "alice", "v1");
    await h.start();
    expect(sent.some((m) => m.type === "ended")).toBe(false);
    await h.endNow({ by: "Dana", message: "Thanks" });
    await expect(h.endNow({})).rejects.toMatchObject({ code: "ended" });
    expect(sent.filter((m) => m.type === "ended")).toHaveLength(1);
    expect(sent[sent.length - 1]!.type).toBe("ended");
    expect(h.seats!.credentials.ended).toBe(true);
  });

  it("a reissue with reason removed reaches reissueRole and a refusal answers the fixed reason", async () => {
    const data = await mk();
    const { parent, sent, ask } = fakeParent();
    const { r } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const h = r.runtime.host;
    h.join("host", "alice");
    h.seats!.credentials.issue("host", "Pat");
    h.giveConsent("host", "alice", "v1");
    // Before the start the removal goes through: a new code, the credential and the consent gone.
    ask({ type: "reissue", requestId: "rm1", roleId: "host", reason: "removed" });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "reissued" && m.requestId === "rm1")).toBe(true));
    expect(h.seats!.credentials.has("host")).toBe(false);
    expect(h.seats!.consent.hasEntry("host")).toBe(false);
    // After the start it is refused with the FIXED reason, while a plain reissue failure keeps its own.
    h.join("host", "bob");
    h.seats!.credentials.issue("host", "Bo");
    h.giveConsent("host", "bob", "v1");
    await h.start();
    ask({ type: "reissue", requestId: "rm2", roleId: "host", reason: "removed" });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "reissue_failed" && m.requestId === "rm2")).toBe(true));
    expect(sent.find((m) => m.type === "reissue_failed" && m.requestId === "rm2")).toMatchObject({ reason: "a participant can only be removed before the start" });
    expect(h.seats!.credentials.has("host")).toBe(true);
    expect(h.seats!.consent.has("host", "bob")).toBe(true);
    await h.endNow({});
    ask({ type: "reissue", requestId: "rm3", roleId: "host" });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "reissue_failed" && m.requestId === "rm3")).toBe(true));
    expect(sent.find((m) => m.type === "reissue_failed" && m.requestId === "rm3")).toMatchObject({ reason: "the code could not be reissued" });
  });

  it("the codes never appear in log or warn output", async () => {
    const data = await mk();
    const { parent, sent } = fakeParent();
    const { r, logs } = await boot(parent, data);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const codes = (sent[0] as Extract<ChildMessage, { type: "codes" }>).codes;
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(logs.join("\n")).not.toContain(c.code);
  });

  it("ready never contains a token or an endpoint", async () => {
    const data = await mk();
    const token = "a".repeat(32) + "b".repeat(32);
    const { parent, sent } = fakeParent();
    const { r } = await boot(parent, data, { FACILITATOR_TOKEN: token, MODEL_PROVIDER: "mock", MODEL_BASE_URL: "https://secret-endpoint.example.com/v1", ANTHROPIC_API_KEY: "sk-secret-key-123" });
    if (!r.ok) throw new Error(r.errors.join("; "));
    const ready = JSON.stringify(sent.find((m) => m.type === "ready"));
    expect(ready).not.toContain(token);
    expect(ready).not.toContain("secret-endpoint");
    expect(ready).not.toContain("sk-secret");
    expect(ready).not.toMatch(/https?:/);
  });

  it("without a parent the start behaves as before (codes go to the display hook only)", async () => {
    const data = await mk();
    const shown: unknown[] = [];
    const r = await bootstrap({
      env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "p1", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", SESSION_DATA_DIR: data },
      root: tmp, tickMs: 60_000, log: () => {}, warn: () => {}, parent: null, showJoinCodes: (c) => { shown.push(c); },
    });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtimes.push(r.runtime);
    expect(shown).toHaveLength(1);
    expect((await readdir(data)).some((n) => n.endsWith(".codes.json"))).toBe(true);
  });
});

describe("watchParent", () => {
  it("on disconnect stops the runtime then exits 0, once, and survives a failing stop", async () => {
    let fire = () => {};
    const parent: ParentChannel = { send: () => true, onMessage() {}, onDisconnect(fn) { fire = fn; } };
    const order: string[] = [];
    const stop = vi.fn(async () => { order.push("stop"); });
    const exit = vi.fn((c: number) => { order.push(`exit${c}`); });
    watchParent(parent, stop, exit);
    expect(stop).not.toHaveBeenCalled();
    fire(); fire();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(["stop", "exit0"]);

    let fire2 = () => {};
    const p2: ParentChannel = { send: () => true, onMessage() {}, onDisconnect(fn) { fire2 = fn; } };
    const exit2 = vi.fn();
    watchParent(p2, async () => { throw new Error("stuck"); }, exit2);
    expect(() => fire2()).not.toThrow();
    await vi.waitFor(() => expect(exit2).toHaveBeenCalledWith(0));
  });

  it("a stop that never resolves still exits 0 once via the hard backstop", () => {
    vi.useFakeTimers();
    try {
      let fire = () => {};
      const parent: ParentChannel = { send: () => true, onMessage() {}, onDisconnect(fn) { fire = fn; } };
      const exit = vi.fn();
      watchParent(parent, () => new Promise<void>(() => {}), exit);
      fire();
      vi.advanceTimersByTime(FATAL_HARD_EXIT_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      vi.advanceTimersByTime(FATAL_HARD_EXIT_MS * 3);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("a normal stop exits once only (the backstop does not exit again)", async () => {
    vi.useFakeTimers();
    try {
      let fire = () => {};
      const parent: ParentChannel = { send: () => true, onMessage() {}, onDisconnect(fn) { fire = fn; } };
      const exit = vi.fn();
      watchParent(parent, async () => undefined, exit);
      fire();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FATAL_HARD_EXIT_MS * 2);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("a stop that throws synchronously still exits", async () => {
    let fire = () => {};
    const parent: ParentChannel = { send: () => true, onMessage() {}, onDisconnect(fn) { fire = fn; } };
    const exit = vi.fn();
    watchParent(parent, () => { throw new Error("sync"); }, exit);
    expect(() => fire()).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
