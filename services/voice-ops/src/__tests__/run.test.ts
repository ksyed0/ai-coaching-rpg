import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isOurWhisper, lstartCandidates, parseLstart, readComm, realRun, realSetTimer, realSpawnDetached, type Run } from "../run.js";
import type { GitRun } from "../env-file.js";

// US-0072 (EPIC-0003 voice A1c, Task 3): the command runner, the detached spawn and the process identity, against REAL processes.
// Every child is a `node` process started from process.execPath; nothing here starts whisper-server, Docker or LiveKit. Nothing measures
// elapsed time: the only timeouts are upper bounds (and one deliberately short runner timeout on a child that sleeps for ten minutes).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let root: string;
let savedTmp: string | undefined;
const started: number[] = [];
beforeAll(() => {
  savedTmp = process.env.TMPDIR;
  root = mkdtempSync(path.join(os.tmpdir(), "acr-voice-ops-run-"));
  process.env.TMPDIR = root;
});
afterAll(() => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});
const newDir = (): string => mkdtempSync(path.join(root, "d-"));
/** macOS CoreFoundation adds this to a Node process's OWN environment at start-up; it is not inherited from the spawn. */
const withoutCf = <T extends Record<string, unknown>>(env: T): T => { const c = { ...env }; delete c.__CF_USER_TEXT_ENCODING; return c; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("realRun (US-0072, A1c Task 3)", () => {
  it("is assignable to the .env writer's GitRun", () => {
    const r: GitRun = realRun;
    const back: Run = r;
    expect(typeof back).toBe("function");
  });

  it("runs without a shell: an argument $(echo x) comes back literally", async () => {
    const r = await realRun(process.execPath, ["-e", "console.log(process.argv[1])", "$(echo x)"], { env: {} });
    expect(r).toEqual({ code: 0, stdout: "$(echo x)\n", stderr: "" });
  });

  it("reports the exit code, and stdout and stderr apart", async () => {
    const r = await realRun(process.execPath, ["-e", "process.stdout.write('o'); process.stderr.write('e'); process.exit(3)"], { env: {} });
    expect(r).toEqual({ code: 3, stdout: "o", stderr: "e" });
  });

  it("passes exactly o.env and resolves the command from its PATH", async () => {
    const bin = newDir();
    const stub = path.join(bin, "acr-run-stub");
    writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()));\n`);
    chmodSync(stub, 0o755);
    const r = await realRun("acr-run-stub", [], { env: { PATH: bin, ACR_MARK: "1" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["ACR_MARK", "PATH"]);
  });

  it("reports a timeout as code null", async () => {
    const r = await realRun(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { env: {}, timeoutMs: 300 });
    expect(r.code).toBeNull();
  });

  it("caps the output at 1 MiB and reports the cut run as code null", async () => {
    const r = await realRun(process.execPath, ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024))"], { env: {} });
    expect(r.code).toBeNull();
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });

  // Review B2 F6: an abort signal ends the run (SIGTERM to the child), and the promise settles only once the child has EXITED (voice:up
  // must never start compose down while compose up still runs, D24).
  it("an aborted run is code null and settles only after the child has exited", async () => {
    const dir = newDir();
    const ready = path.join(dir, "ready");
    const ended = path.join(dir, "ended");
    // A fixed program; the two paths are arguments, never generated code (PR #135, CodeQL js/bad-code-sanitization).
    const code = 'const fs=require("node:fs");const [ended,ready]=process.argv.slice(1);process.on("SIGTERM",()=>{setTimeout(()=>{fs.writeFileSync(ended,"x");process.exit(0)},300)});fs.writeFileSync(ready,"x");setInterval(()=>{},1000)';
    const ctl = new AbortController();
    const p = realRun(process.execPath, ["-e", code, ended, ready], { env: {}, signal: ctl.signal, timeoutMs: 60_000 });
    await vi.waitFor(() => { expect(existsSync(ready)).toBe(true); }, { timeout: 60_000, interval: 20 });
    ctl.abort();
    const r = await p;
    expect(r.code).toBeNull();
    expect(existsSync(ended)).toBe(true);
  });

  // Review B2 F3: voice:up's rollback runs compose down detached, so a second Ctrl-C to the terminal's process group cannot cut it.
  it("detached: true runs the child in its own process group", async () => {
    const code = `const r=require("node:child_process").execFileSync("ps",["-o","pgid=","-p",String(process.pid)],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8"});process.stdout.write(JSON.stringify({pid:process.pid,pgid:Number(r.trim())}))`;
    const own = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim());
    const d = JSON.parse((await realRun(process.execPath, ["-e", code], { env: {}, detached: true })).stdout) as { pid: number; pgid: number };
    expect(d.pgid).toBe(d.pid);
    expect(d.pgid).not.toBe(own);
    const a = JSON.parse((await realRun(process.execPath, ["-e", code], { env: {} })).stdout) as { pid: number; pgid: number };
    expect(a.pgid).toBe(own);
  });

  it("a run whose signal is already aborted starts nothing that outlives it", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await realRun(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, signal: ctl.signal, timeoutMs: 60_000 });
    expect(r.code).toBeNull();
  });

  // Review B2 F5: a call that forgets the environment would get the whole process.env (the keys a shell exported included): refused.
  it("refuses a call without an environment and starts nothing", async () => {
    const loose = realRun as unknown as (cmd: string, args: string[], o?: object) => Promise<unknown>;
    const marker = path.join(newDir(), "ran");
    const code = 'require("node:fs").writeFileSync(process.argv[1], "x")';
    await expect(loose(process.execPath, ["-e", code, marker])).rejects.toThrow("needs an explicit environment");
    await expect(loose(process.execPath, ["-e", code, marker], { timeoutMs: 1000 })).rejects.toThrow("needs an explicit environment");
    expect(existsSync(marker)).toBe(false);
  });

  it("throws when the command does not exist (git missing: the tracked check skips)", async () => {
    await expect(realRun("acr-no-such-command-xyz", [], { env: { PATH: newDir() } })).rejects.toThrow();
  });
});

describe("realSetTimer (US-0072, A1c Task 3)", () => {
  it("fires once, and a cancel before it fires stops it", async () => {
    const hits: string[] = [];
    const cancel = realSetTimer(() => hits.push("cancelled"), 1);
    cancel();
    await new Promise<void>((resolve) => realSetTimer(() => { hits.push("fired"); resolve(); }, 1));
    expect(hits).toEqual(["fired"]);
  });
});

describe("realSpawnDetached (US-0072, A1c Task 3)", () => {
  it("sends stderr to the 0600 log and discards stdout", async () => {
    const dir = newDir();
    const log = path.join(dir, "child.log");
    const { pid } = realSpawnDetached(process.execPath, ["-e", "process.stdout.write('STDOUT-MARKER\\n'); process.stderr.write('STDERR-MARKER\\n')"], { logFile: log, env: {}, cwd: dir });
    started.push(pid);
    await vi.waitFor(() => { expect(alive(pid)).toBe(false); }, { timeout: 60_000, interval: 50 });
    await vi.waitFor(() => { expect(readFileSync(log, "utf8")).toContain("STDERR-MARKER"); }, { timeout: 60_000, interval: 50 });
    expect(readFileSync(log, "utf8")).not.toContain("STDOUT-MARKER");
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("appends to an existing log and makes it 0600", async () => {
    const dir = newDir();
    const log = path.join(dir, "child.log");
    writeFileSync(log, "BEFORE\n", { mode: 0o644 });
    chmodSync(log, 0o644);
    const { pid } = realSpawnDetached(process.execPath, ["-e", "process.stderr.write('AFTER\\n')"], { logFile: log, env: {}, cwd: dir });
    started.push(pid);
    await vi.waitFor(() => { expect(readFileSync(log, "utf8")).toBe("BEFORE\nAFTER\n"); }, { timeout: 60_000, interval: 50 });
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("runs in the given cwd with exactly the given environment", async () => {
    const dir = newDir();
    const log = path.join(dir, "child.log");
    const code = "process.stderr.write(JSON.stringify({ cwd: process.cwd(), env: process.env }) + '\\n')";
    const { pid } = realSpawnDetached(process.execPath, ["-e", code], { logFile: log, env: { PATH: "/usr/bin:/bin", HOME: dir }, cwd: dir });
    started.push(pid);
    await vi.waitFor(() => { expect(readFileSync(log, "utf8")).toContain("\n"); }, { timeout: 60_000, interval: 50 });
    const seen = JSON.parse(readFileSync(log, "utf8").trim()) as { cwd: string; env: Record<string, string> };
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
    expect(withoutCf(seen.env)).toEqual({ PATH: "/usr/bin:/bin", HOME: dir });
  });

  // Batch 2 review B F4: `detached: true` puts the child in its own session and process group (setsid), so a Ctrl-C to the terminal's
  // process group never reaches whisper-server. Its process group id is its own pid, not this test's.
  it("starts the child in its own process group (detached)", async () => {
    const dir = newDir();
    const { pid } = realSpawnDetached(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { logFile: path.join(dir, "g.log"), env: {}, cwd: dir });
    started.push(pid);
    const pgidOf = (p: number): number => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(p)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim());
    const own = pgidOf(process.pid);
    expect(own).toBeGreaterThan(0);
    expect(pgidOf(pid)).toBe(pid);
    expect(pgidOf(pid)).not.toBe(own);
  });

  // Batch 2 review B F5: the handle tells whether the child this run spawned has exited (no `ps`, no pid reuse question).
  it("exited() is false while the child runs and true once it has exited", async () => {
    const dir = newDir();
    const long = realSpawnDetached(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { logFile: path.join(dir, "l.log"), env: {}, cwd: dir });
    started.push(long.pid);
    const short = realSpawnDetached(process.execPath, ["-e", ""], { logFile: path.join(dir, "s.log"), env: {}, cwd: dir });
    started.push(short.pid);
    await vi.waitFor(() => { expect(short.exited()).toBe(true); }, { timeout: 60_000, interval: 50 });
    expect(long.exited()).toBe(false);
    process.kill(long.pid, "SIGTERM");
    await vi.waitFor(() => { expect(long.exited()).toBe(true); }, { timeout: 60_000, interval: 50 });
  });

  it("refuses a log that is a symbolic link (O_NOFOLLOW) and starts nothing", () => {
    const dir = newDir();
    const target = path.join(dir, "target.log");
    writeFileSync(target, "", { mode: 0o600 });
    const log = path.join(dir, "child.log");
    spawnSync("ln", ["-s", target, log]);
    expect(() => realSpawnDetached(process.execPath, ["-e", "process.stderr.write('X')"], { logFile: log, env: {}, cwd: dir })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("throws a fixed error when the command cannot be started, naming no path", () => {
    const dir = newDir();
    let err: unknown;
    try { realSpawnDetached("acr-no-such-command-xyz", [], { logFile: path.join(dir, "x.log"), env: { PATH: dir }, cwd: dir }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(dir);
  });
});

describe("process identity (US-0072, A1c Task 3)", () => {
  /** A detached node child that sleeps, with `--port <n>` as two words in its arguments, as whisper-server has. */
  async function sleeper(port: number): Promise<{ pid: number; startedAt: number; comm: string }> {
    const dir = newDir();
    const { pid } = realSpawnDetached(process.execPath, ["-e", "setTimeout(() => {}, 600000)", "--", "--port", String(port)], { logFile: path.join(dir, "s.log"), env: {}, cwd: dir });
    started.push(pid);
    const startedAt = Date.now();
    const comm = await readComm(pid, realRun);
    expect(comm).not.toBeNull();
    return { pid, startedAt, comm: comm! };
  }

  it("parseLstart reads the ps lstart format and refuses anything else", () => {
    expect(parseLstart("Mon Nov  9 12:00:05 2026")).toBe(new Date(2026, 10, 9, 12, 0, 5).getTime());
    expect(parseLstart("Tue Dec 31 23:59:59 2030\n")).toBe(new Date(2030, 11, 31, 23, 59, 59).getTime());
    for (const bad of ["", "garbage", "Mon Foo 9 12:00:00 2026", "Mon Nov 32 12:00:00 2026", "Mon Nov 9 25:00:00 2026", "Mon Nov 9 12:00 2026", "Mon Nov 9 12:00:00"]) {
      expect(parseLstart(bad), bad).toBeNull();
    }
  });

  // Batch 2 review B F6: in the repeated hour of the autumn change local time is ambiguous; `new Date(y, m, d, h, mi, s)` picks the
  // earlier offset, so a whisper-server started in the second 01:30 parsed an hour off and voice:down called it "not ours". Both
  // readings are accepted. TZ is set in this process (Node resets its time zone on assignment) and restored in `finally`.
  it("an lstart in the repeated hour of the autumn change accepts either reading (America/New_York, 2026-11-01)", async () => {
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const first = Date.UTC(2026, 10, 1, 5, 30, 0); // 01:30 EDT
      const second = Date.UTC(2026, 10, 1, 6, 30, 0); // 01:30 EST, one hour later
      expect(new Date(first).getHours()).toBe(1); // the zone is in effect
      expect(lstartCandidates("Sun Nov  1 01:30:00 2026")).toEqual([first, second]);
      expect(lstartCandidates("Sun Nov  1 03:30:00 2026")).toEqual([Date.UTC(2026, 10, 1, 8, 30, 0)]); // unambiguous: one reading
      expect(lstartCandidates("Sun Mar  8 12:00:00 2026")).toEqual([Date.UTC(2026, 2, 8, 16, 0, 0)]);
      expect(lstartCandidates("garbage")).toBeNull();
      const fake = (lstart: string): Run => async (_cmd, args) => {
        if (args[1] === "comm=") return { code: 0, stdout: "whisper-server\n", stderr: "" };
        if (args[1] === "lstart=") return { code: 0, stdout: `${lstart}\n`, stderr: "" };
        return { code: 0, stdout: "whisper-server --host 127.0.0.1 --port 24680\n", stderr: "" };
      };
      for (const startedAt of [first + 2000, second + 2000]) {
        expect(await isOurWhisper({ pid: 123, port: 24680, startedAt, comm: "whisper-server" }, fake("Sun Nov  1 01:30:00 2026")), String(startedAt)).toBe("ours");
      }
      expect(await isOurWhisper({ pid: 123, port: 24680, startedAt: second + 3_600_000, comm: "whisper-server" }, fake("Sun Nov  1 01:30:00 2026"))).toBe("not_ours");
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  it("isOurWhisper is ours for the process it started (comm, start time and --port recorded as voice:up does)", async () => {
    const w = await sleeper(41001);
    expect(await isOurWhisper({ ...w, port: 41001 }, realRun)).toBe("ours");
  });

  it("isOurWhisper is not_ours for a live pid of another program (the test's own pid)", async () => {
    expect(await isOurWhisper({ pid: process.pid, port: 41002, startedAt: Date.now(), comm: "whisper-server" }, realRun)).toBe("not_ours");
  });

  it("isOurWhisper is not_ours when the start time is more than 5 s from startedAt (pid reuse)", async () => {
    const w = await sleeper(41003);
    expect(await isOurWhisper({ ...w, port: 41003, startedAt: w.startedAt - 10_000 }, realRun)).toBe("not_ours");
    expect(await isOurWhisper({ ...w, port: 41003, startedAt: w.startedAt + 10_000 }, realRun)).toBe("not_ours");
  });

  it("isOurWhisper is not_ours when --port differs (pid reuse)", async () => {
    const w = await sleeper(41004);
    expect(await isOurWhisper({ ...w, port: 41005 }, realRun)).toBe("not_ours");
    expect(await isOurWhisper({ ...w, port: 4100 }, realRun)).toBe("not_ours"); // a prefix of the real port is not the port
  });

  it("isOurWhisper is not_ours for a dead pid (ps exits 1 with no output)", async () => {
    const r = spawnSync(process.execPath, ["-e", ""]);
    expect(r.pid).toBeGreaterThan(0);
    expect(existsSync(process.execPath)).toBe(true);
    expect(await isOurWhisper({ pid: r.pid, port: 41006, startedAt: Date.now(), comm: "node" }, realRun)).toBe("not_ours");
  });

  it("isOurWhisper is not_ours for a bad pid", async () => {
    expect(await isOurWhisper({ pid: 0, port: 1, startedAt: 0, comm: "node" }, realRun)).toBe("not_ours");
    expect(await isOurWhisper({ pid: -5, port: 1, startedAt: 0, comm: "node" }, realRun)).toBe("not_ours");
  });

  // Review B2 F4: a ps that cannot answer (not found, a timeout, any other failure) is "unknown", never "not_ours": voice:down would
  // otherwise call a running whisper-server another program's and drop its record.
  it("isOurWhisper is unknown when ps cannot be run, times out or fails, at any of its three questions, without throwing", async () => {
    const throwing: Run = async () => { throw new Error("no ps"); };
    expect(await isOurWhisper({ pid: process.pid, port: 1, startedAt: Date.now(), comm: "node" }, throwing)).toBe("unknown");
    const failAt = (field: string, r: { code: number | null; stderr: string }): Run => async (_cmd, args) => {
      if (args[1] === field) return { code: r.code, stdout: "", stderr: r.stderr };
      if (args[1] === "comm=") return { code: 0, stdout: "whisper-server\n", stderr: "" };
      if (args[1] === "lstart=") return { code: 0, stdout: "Mon Nov  9 12:00:05 2026\n", stderr: "" };
      return { code: 0, stdout: "whisper-server --port 24680\n", stderr: "" };
    };
    const w = { pid: 123, port: 24680, startedAt: new Date(2026, 10, 9, 12, 0, 3).getTime(), comm: "whisper-server" };
    for (const field of ["comm=", "lstart=", "args="]) {
      expect(await isOurWhisper(w, failAt(field, { code: null, stderr: "" })), `timeout at ${field}`).toBe("unknown");
      expect(await isOurWhisper(w, failAt(field, { code: 1, stderr: "ps: something went wrong" })), `error at ${field}`).toBe("unknown");
      expect(await isOurWhisper(w, failAt(field, { code: 2, stderr: "" })), `exit 2 at ${field}`).toBe("unknown");
      expect(await isOurWhisper(w, failAt(field, { code: 1, stderr: "" })), `gone at ${field}`).toBe("not_ours");
    }
  });

  it("asks ps with a fixed PATH and the C locale, and never prints what it read", async () => {
    const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const spyErr = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const fake: Run = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o?.env });
      const field = args[1];
      if (field === "comm=") return { code: 0, stdout: "/opt/homebrew/bin/whisper-server\n", stderr: "" };
      if (field === "lstart=") return { code: 0, stdout: "Mon Nov  9 12:00:05 2026\n", stderr: "" };
      return { code: 0, stdout: "whisper-server --host 127.0.0.1 --port 24680 --request-path /SECRETPATH -m /m.bin\n", stderr: "" };
    };
    const startedAt = new Date(2026, 10, 9, 12, 0, 3).getTime();
    expect(await isOurWhisper({ pid: 123, port: 24680, startedAt, comm: "whisper-server" }, fake)).toBe("ours");
    spy.mockRestore(); spyErr.mockRestore();
    expect(lines).toEqual([]);
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["ps", "-o", "comm=", "-p", "123"], ["ps", "-o", "lstart=", "-p", "123"], ["ps", "-o", "args=", "-p", "123"],
    ]);
    for (const c of calls) { expect(c.env?.PATH).toBe("/usr/bin:/bin"); expect(c.env?.LC_ALL).toBe("C"); }
  });
});

describe("the test helpers are honest", () => {
  it("the private temp directory is used", () => {
    expect(os.tmpdir()).toBe(root);
    mkdirSync(path.join(root, "probe"));
    expect(existsSync(path.join(root, "probe"))).toBe(true);
  });
});
