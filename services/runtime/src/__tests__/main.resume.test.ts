import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { SessionEvent } from "@acr/events";
import { bootstrap, type Runtime } from "../main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../../../../packages/script/src/__tests__/fixtures/minimal");
const runtimeDir = path.resolve(here, "../..");
const tsx = path.join(runtimeDir, "node_modules", ".bin", "tsx");

/** tsx runs the script in a node grandchild: the whole process group must die (spawned detached, so it has its own group). */
const killGroup = (c: ChildProcess) => { if (c.pid === undefined) return; try { process.kill(-c.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } };
// Every test here starts real servers (and one a real child process): give a loaded CI runner room; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
/** US-0033: the join codes the last start that issued codes showed (kept across restarts, like the codes on a facilitator's sheet). */
let codes: Record<string, string> = {};
let shownTimes = 0;
const runtimes: Runtime[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) killGroup(c);
  for (const r of runtimes.splice(0)) await r.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = ""; codes = {}; shownTimes = 0;
});

const env = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "r1", MODEL_PROVIDER: "mock", ...extra });
const dataDir = () => path.join(tmp, "data");
async function boot(extra: Record<string, string> = {}, logs: string[] = [], onFatal?: () => void, beforeLockCheck?: () => void) {
  const r = await bootstrap({ env: env(extra), root: tmp, logDir: dataDir(), tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), onFatal, testHooks: { beforeLockCheck },
    showJoinCodes: (list) => { shownTimes++; codes = Object.fromEntries(list.map((c) => [c.roleId, c.code])); } });
  if (r.ok) runtimes.push(r.runtime);
  return r;
}

type Msg = { type: string; event?: SessionEvent; state?: { paused: boolean; transcript: { text: string }[] }; code?: string };
class Client {
  readonly inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
  }
  static open(port: number): Promise<Client> {
    return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(new Client(w))); w.on("error", rej); });
  }
  waitFor(pred: (m: Msg) => boolean, what: string): Promise<Msg> {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 60_000);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  close(): void { this.ws.close(); }
}
const isEv = (type: string, f: (e: SessionEvent) => boolean = () => true) => (m: Msg) => m.type === "event" && m.event?.type === type && f(m.event);

async function playUntilALine(port: number) {
  const fac = await Client.open(port);
  fac.send({ type: "join_facilitator", sessionId: "r1" });
  await fac.waitFor((m) => m.type === "joined", "facilitator joined");
  const p = await Client.open(port);
  p.send({ type: "join", sessionId: "r1", roleId: "host", participantId: "alice", joinCode: codes.host });
  await p.waitFor((m) => m.type === "joined", "player joined");
  fac.send({ type: "start" });
  await fac.waitFor(isEv("scene.entered"), "scene 1");
  p.send({ type: "say", text: "a line before the crash" });
  await fac.waitFor(isEv("utterance", (e) => e.type === "utterance" && e.roleId === "guest"), "the AI character's reply");
  return { fac, p };
}

describe("bootstrap: fail-stop when the log cannot be written (US-0018)", () => {
  async function joined(port: number) {
    const fac = await Client.open(port);
    fac.send({ type: "join_facilitator", sessionId: "r1" });
    await fac.waitFor((m) => m.type === "joined", "facilitator joined");
    const p = await Client.open(port);
    p.send({ type: "join", sessionId: "r1", roleId: "host", participantId: "alice", joinCode: codes.host });
    await p.waitFor((m) => m.type === "joined", "player joined");
    fac.send({ type: "start" });
    await fac.waitFor(isEv("scene.entered"), "scene 1");
    return { fac, p };
  }
  const notice = (m: Msg) => m.type === "error" && m.code === "log_failed" && /stopping/.test((m as { message?: string }).message ?? "");

  it("a failed sync: every client gets an unlogged notice, input is refused, onFatal runs once, one FATAL line (no path)", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-fatal-"));
    const logs: string[] = []; let fatal = 0;
    const r = await boot({}, logs, () => { fatal++; });
    if (!r.ok) throw new Error(r.errors.join("; "));
    const { fac, p } = await joined(r.runtime.port);
    const fh = await open(path.join(tmp, "probe"), "w"); const proto = Object.getPrototypeOf(fh) as { datasync: () => Promise<void> }; await fh.close();
    const orig = proto.datasync; let failNext = true;
    proto.datasync = function (this: unknown) { if (failNext) { failNext = false; return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })); } return orig.call(this); };
    try {
      const before = (await readFile(path.join(dataDir(), "r1.jsonl"))).length;
      p.send({ type: "say", text: "this write fails" });
      await fac.waitFor(notice, "the facilitator's notice");
      await p.waitFor(notice, "the player's notice");
      p.send({ type: "say", text: "refused" });
      await p.waitFor((m) => m.type === "error" && m.code === "log_failed" && !notice(m), "the refusal");
      fac.send({ type: "command", command: { command: "advance" } });
      await fac.waitFor((m) => m.type === "error" && m.code === "log_failed" && !notice(m), "the facilitator's refusal");
      expect(fatal).toBe(1);
      const fatalLines = logs.filter((l) => l.startsWith("FATAL"));
      expect(fatalLines).toHaveLength(1);
      expect(fatalLines[0]).not.toContain(tmp);
      const after = await readFile(path.join(dataDir(), "r1.jsonl"));
      expect(after.subarray(before).toString().split("\n").filter(Boolean)).toHaveLength(1); // only the line whose sync failed
      expect(fac.inbox.filter(notice)).toHaveLength(1);
    } finally { proto.datasync = orig; fac.close(); p.close(); }
  });

  it("a lock lost WHILE bootstrap runs still ends in FATAL and the owner's exit", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-fatal-"));
    const logs: string[] = []; let fatal = 0;
    const { rmSync } = await import("node:fs");
    const r = await boot({}, logs, () => { fatal++; }, () => rmSync(path.join(dataDir(), "r1.lock")));
    expect(r.ok).toBe(true);
    expect(fatal).toBe(1);
    expect(logs.filter((l) => l.startsWith("FATAL"))).toHaveLength(1);
  });

  it("scheduleFatalExit: drains, stops and exits 1; a stop that hangs is cut by the hard backstop; exit is called once", async () => {
    const { scheduleFatalExit } = await import("../main.js");
    vi.useFakeTimers();
    try {
      const codes: number[] = [];
      scheduleFatalExit({ stop: () => new Promise(() => {}), exit: (c) => codes.push(c), drainMs: 2_000, hardMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(codes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(codes).toEqual([1]);
      const ok: number[] = []; let stopped = false;
      scheduleFatalExit({ stop: async () => { stopped = true; }, exit: (c) => ok.push(c), drainMs: 2_000, hardMs: 5_000 });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      expect(ok).toEqual([1]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ok).toEqual([1]);
    } finally { vi.useRealTimers(); }
  });

  it("a lost lock (removed under the running server) is fail-stop too", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-fatal-"));
    let fatal = 0;
    const r = await boot({}, [], () => { fatal++; });
    if (!r.ok) throw new Error(r.errors.join("; "));
    const { fac, p } = await joined(r.runtime.port);
    await rm(path.join(dataDir(), "r1.lock"));
    p.send({ type: "say", text: "after the lock was removed" });
    await fac.waitFor(notice, "the notice");
    expect(fatal).toBe(1);
    const events = (await readFile(path.join(dataDir(), "r1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
    expect(events.some((e) => e.type === "utterance" && e.text === "after the lock was removed")).toBe(false);
    fac.close(); p.close();
  });
});

describe("bootstrap: resume after a restart (US-0018)", () => {
  it("a restart RESUMES a running session from its log (no rotation), paused; a rejoining player gets its history; /resume continues", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-resume-"));
    const first = await boot();
    if (!first.ok) throw new Error(first.errors.join("; "));
    const { fac, p } = await playUntilALine(first.runtime.port);
    fac.close(); p.close();
    await first.runtime.stop(); runtimes.pop();
    const before = (await readFile(path.join(dataDir(), "r1.jsonl"), "utf8")).split("\n").filter(Boolean);

    const logs: string[] = [];
    const second = await boot({}, logs);
    if (!second.ok) throw new Error(second.errors.join("; "));
    expect(logs.join("\n")).toMatch(/session RESUMED from its log/);
    expect(logs.join("\n")).not.toMatch(/moved aside/);
    expect((await readdir(dataDir())).filter((f) => f.endsWith(".jsonl"))).toEqual(["r1.jsonl"]);
    const after = (await readFile(path.join(dataDir(), "r1.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(after.slice(0, before.length)).toEqual(before); // the old events are untouched
    expect(after.slice(before.length).map((l) => (JSON.parse(l) as SessionEvent).type)).toEqual(["session.resumed", "facilitator.alert"]);

    const port = second.runtime.port;
    const fac2 = await Client.open(port);
    fac2.send({ type: "join_facilitator", sessionId: "r1" });
    const fj = await fac2.waitFor((m) => m.type === "joined", "facilitator rejoined");
    expect(fj.state?.paused).toBe(true);
    const p2 = await Client.open(port);
    expect(shownTimes).toBe(1); // US-0033: the restart keeps the codes that were handed out and does not show them again
    expect(logs.join("\n")).toMatch(/codes issued earlier for this session still apply/);
    expect(logs.join("\n")).not.toContain(codes.host!);
    const stranger = await Client.open(port);
    stranger.send({ type: "join", sessionId: "r1", roleId: "host", participantId: "mallory" });
    expect((await stranger.waitFor((m) => m.type === "error", "the refusal without a code")).code).toBe("unauthorized"); // a restart frees no role
    p2.send({ type: "join", sessionId: "r1", roleId: "host", participantId: "alice", joinCode: codes.host });
    const pj = await p2.waitFor((m) => m.type === "joined", "player rejoined");
    expect(pj.state?.transcript.map((u) => u.text)).toContain("a line before the crash");
    p2.send({ type: "say", text: "too early" });
    expect((await p2.waitFor((m) => m.type === "error", "the paused refusal")).code).toBe("paused");
    fac2.send({ type: "command", command: { command: "resume" } });
    await p2.waitFor(isEv("facilitator.command", (e) => e.type === "facilitator.command" && e.command === "resume"), "resume");
    p2.send({ type: "say", text: "after the restart" });
    await fac2.waitFor(isEv("utterance", (e) => e.type === "utterance" && e.text === "after the restart"), "a line after the restart");
    fac2.close(); p2.close();
  });

  it("refuses a second server on the same session log while the first runs, and changes nothing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-resume-"));
    const first = await boot();
    if (!first.ok) throw new Error(first.errors.join("; "));
    const second = await boot({ SESSION_START: "fresh" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors.join("\n")).toMatch(/locked by another server process|already open in this server process/);
  });

  it("refuses a corrupt log with a message that names SESSION_START=fresh, then SESSION_START=fresh moves it aside", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-resume-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir(), { recursive: true });
    await writeFile(path.join(dataDir(), "r1.jsonl"), "{garbage\n{more garbage\n");
    const r = await boot();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/cannot resume the session from its log: malformed event in r1\.jsonl at line 1.*SESSION_START=fresh/);
    expect(await readFile(path.join(dataDir(), "r1.jsonl"), "utf8")).toBe("{garbage\n{more garbage\n");
    const logs: string[] = [];
    const fresh = await boot({ SESSION_START: "fresh" }, logs);
    expect(fresh.ok).toBe(true);
    expect(logs.join("\n")).toMatch(/moved aside/);
  });

  it.each([["SESSION_START", "later", /SESSION_START must be resume or fresh/], ["SESSION_LOCK_STALE_MS", "10", /SESSION_LOCK_STALE_MS must be/]])("an invalid %s is refused before any filesystem action, without echoing it", async (name, value, msg) => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-resume-"));
    const r = await boot({ [name]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("\n")).toMatch(msg); expect(r.errors.join("\n")).not.toContain(`"${value}"`); }
    expect(await readdir(tmp)).toEqual([]);
  });

  it("survives a REAL crash (SIGKILL of the server process): the restart takes the dead process's lock over and resumes every event", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-crash-"));
    const child = path.join(tmp, "child.mts");
    await writeFile(child, [
      `import { bootstrap } from ${JSON.stringify(pathToFileURL(path.join(runtimeDir, "src", "main.ts")).href)};`,
      `const r = await bootstrap({ env: ${JSON.stringify(env())}, root: ${JSON.stringify(tmp)}, logDir: ${JSON.stringify(dataDir())}, tickMs: 60000, log: () => {}, warn: () => {}, showJoinCodes: (c) => console.log("CODES " + JSON.stringify(c)) });`,
      `if (!r.ok) { console.log("FAILED " + r.errors.join("; ")); process.exit(1); }`,
      `console.log("PORT " + r.runtime.port);`,
    ].join("\n"));
    const proc = spawn(tsx, [child], { cwd: runtimeDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    children.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error(`the server process did not start: ${out}`)), 60_000);
      proc.stdout!.on("data", (d) => {
        out += d;
        const c = /CODES (\[.*\])/.exec(out); if (c) codes = Object.fromEntries((JSON.parse(c[1]!) as { roleId: string; code: string }[]).map((x) => [x.roleId, x.code]));
        const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } if (out.includes("FAILED")) { clearTimeout(t); reject(new Error(out)); }
      });
      proc.once("exit", (c) => { clearTimeout(t); reject(new Error(`the server process exited (${c}): ${out}`)); });
    });
    const { fac, p } = await playUntilALine(port);
    const seen = fac.inbox.filter((m) => m.type === "event").map((m) => m.event!.seq);
    const exited = new Promise((r) => proc.once("exit", r));
    const serverPid = (JSON.parse(await readFile(path.join(dataDir(), "r1.lock"), "utf8")) as { pid: number }).pid;
    killGroup(proc);
    await exited;
    // The server (tsx's node grandchild) must really be gone before the restart: poll its pid (no fixed sleep).
    let gone = false;
    for (const deadline = Date.now() + 30_000; !gone && Date.now() < deadline;) { try { process.kill(serverPid, 0); await new Promise((r) => setTimeout(r, 25)); } catch { gone = true; } } // a wait for the OS, bounded only to avoid a hang
    // In a container whose PID 1 does not reap orphans the killed server stays a zombie, which still answers kill(pid, 0): its lock
    // then looks live and the restart must wait for the stale age. Age the lock instead (as if the crash were a minute ago).
    if (!gone) { const t = (Date.now() - 600_000) / 1000; await utimes(path.join(dataDir(), "r1.lock"), t, t); } // 10 min: far past the 30 s stale age
    fac.close(); p.close();
    expect(await readdir(dataDir())).toContain("r1.lock"); // the dead process left its lock behind

    const logs: string[] = [];
    const r = await boot({}, logs);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(logs.join("\n")).toMatch(/session RESUMED/);
    const events = (await readFile(path.join(dataDir(), "r1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
    for (const seq of seen) expect(events.some((e) => e.seq === seq)).toBe(true); // every event a client saw survived the crash
    expect(events.at(-2)).toMatchObject({ type: "session.resumed" });
    expect(JSON.parse(await readFile(path.join(dataDir(), "r1.lock"), "utf8"))).toMatchObject({ pid: process.pid });
    // US-0033: the code the dead process issued still opens the role after the real crash; no new codes were shown.
    expect(shownTimes).toBe(0);
    const p2 = await Client.open(r.runtime.port);
    p2.send({ type: "join", sessionId: "r1", roleId: "host", participantId: "alice", joinCode: codes.host });
    expect((await p2.waitFor((m) => m.type === "joined" || m.type === "error", "the rejoin after the crash")).type).toBe("joined");
    p2.close();
  }, 90_000);
});
