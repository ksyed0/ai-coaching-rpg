import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { existsSync, realpathSync, statSync, statfsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { httpAnswers } from "@acr/adapters";
import { voiceCheck, type CheckDeps } from "./check.js";
import { voiceDown } from "./down.js";
import { STT_PORT_MAX, STT_PORT_MIN } from "./env-file.js";
import type { OpsDeps } from "./ops.js";
import { realRun, realSpawnDetached, type SetTimer } from "./run.js";
import { makeResolver } from "./checks/dns.js";
import { trustStore } from "./trust.js";
import { portFree } from "./port-probe.js";
import { exitCodeOf, installSignals, lastLine, type RollbackOutcome } from "./signals.js";
import { voiceUpOutcome } from "./up.js";
import { whisperHealth, whisperWarm } from "./whisper.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 7): the `voice-ops` command line, `node --import tsx src/cli.ts up|down|check|timings`. Thin wiring
 * of real built-ins into `OpsDeps` (excluded from the coverage count by name; covered by `cli.process.test.ts`).
 *
 * - The package scripts run `node --import tsx` directly, not the `tsx` command (batch 3 note D20): `tsx`'s own wrapper process was
 *   seen to end the CLI before its rollback finished when a Ctrl-C reached the whole process group (pnpm, tsx and the CLI); with
 *   `node --import tsx` the CLI is pnpm's direct child and its rollback completes.
 * - Signals (`signals.ts`): for `up` the first SIGINT or SIGTERM fires the interrupt (voice:up rolls back what it started) and every
 *   later one is ignored until the command ends, then the exit is 130 (SIGINT) or 143; every other command exits at the first signal.
 * - The repository root: VOICE_OPS_REPO_ROOT when set (absolute, holding pnpm-workspace.yaml: the process tests act on a private copy),
 *   else the nearest parent of this file holding pnpm-workspace.yaml.
 */

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function repoRoot(): string | null {
  const forced = process.env.VOICE_OPS_REPO_ROOT;
  if (forced !== undefined && forced !== "") {
    return path.isAbsolute(forced) && existsSync(path.join(forced, "pnpm-workspace.yaml")) ? path.resolve(forced) : null;
  }
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** A timer that keeps the process alive while voice:up waits (realSetTimer is unref'd, which would let the CLI exit mid-wait). */
const refSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = STT_PORT_MIN + (randomBytes(2).readUInt16BE(0) % (STT_PORT_MAX - STT_PORT_MIN + 1));
    if ((await portFree("127.0.0.1", port, "tcp")) === "free") return port;
  }
  throw new Error("no free port for whisper-server in 20000..32767");
}

/** Node's CAs plus the system store (trust.ts; review B2 F9: missing before Node 22.15, then reported by voice:up and voice:check). */
const TRUST = trustStore(tls);

/** A TLS handshake to host:port with SNI `servername`, then `GET /rtc/validate`; the HTTP status of the answer (any) or null. */
function tlsConnect(host: string, port: number, servername: string): Promise<{ authorized: boolean; status: number | null }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { authorized: boolean; status: number | null }): void => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    const sock = tls.connect({ host, port, servername, ca: TRUST.cas, rejectUnauthorized: false, timeout: 5_000 });
    let buf = "";
    sock.once("secureConnect", () => {
      if (!sock.authorized) { finish({ authorized: false, status: null }); return; }
      sock.write(`GET /rtc/validate HTTP/1.1\r\nHost: ${servername}:${port}\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (c: Buffer) => {
      buf += c.toString("latin1");
      const eol = buf.indexOf("\r\n");
      if (eol < 0) { if (buf.length > 4096) finish({ authorized: true, status: null }); return; }
      const parts = buf.slice(0, eol).split(" ");
      const status = parts[0]?.startsWith("HTTP/") ? Number(parts[1]) : NaN;
      finish({ authorized: true, status: Number.isInteger(status) ? status : null });
    });
    sock.once("timeout", () => finish({ authorized: sock.authorized, status: null }));
    sock.once("error", () => finish({ authorized: false, status: null }));
    sock.once("end", () => finish({ authorized: sock.authorized, status: null }));
  });
}

const signals = installSignals({ cmd: process.argv[2], on: (sig, fn) => { process.on(sig, fn); }, exit: (code) => { process.exit(code); } });

function deps(root: string): OpsDeps {
  return {
    env: process.env, home: os.homedir(), repoRoot: root, out: say,
    run: realRun, spawnDetached: realSpawnDetached, kill: (pid, sig) => { process.kill(pid, sig); }, pid: process.pid,
    freePort, portFree, random: (n) => randomBytes(n), now: () => Date.now(), setTimer: refSetTimer,
    interfaces: () => os.networkInterfaces(),
    onInterrupt: signals.onInterrupt,
    tlsConnect, systemTrust: TRUST.system,
    health: (u) => whisperHealth(u), warm: (u) => whisperWarm(u), answers: (u) => httpAnswers(u),
  };
}

/** A TCP connect with a 2 s bound: open, refused (any error) or timeout. */
function tcpConnect(host: string, port: number): Promise<"open" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (v: "open" | "refused" | "timeout"): void => { sock.destroy(); resolve(v); };
    sock.setTimeout(2_000, () => finish("timeout"));
    sock.once("connect", () => finish("open"));
    sock.once("error", () => finish("refused"));
  });
}

/** whisper-server on PATH, resolved through links (Homebrew: .../Cellar/<formula>/<version>/bin/whisper-server), or null. */
function whisperPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const f = path.join(dir, "whisper-server");
    try { if (statSync(f).isFile()) return realpathSync(f); } catch { /* next */ }
  }
  return null;
}

function checkDeps(root: string): CheckDeps {
  const resolver = makeResolver(); // bounded: review B2 F6
  return {
    ...deps(root),
    resolve4: (h) => resolver.resolve4(h), resolve6: (h) => resolver.resolve6(h),
    lookup: (h) => dns.promises.lookup(h, { all: true }),
    statfs: (p) => { const st = statfsSync(p); return { bavail: Number(st.bavail), bsize: Number(st.bsize) }; },
    tcpConnect, platform: process.platform, whisperPath,
  };
}

let rollback: RollbackOutcome = "none";

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const root = repoRoot();
  if (root === null) { say("voice-ops: VOICE_OPS_REPO_ROOT must be an absolute path to a folder holding pnpm-workspace.yaml"); return 2; }
  switch (cmd) {
    case "up": { const r = await voiceUpOutcome(deps(root)); rollback = r.rollback; return r.code; }
    case "down": return voiceDown(deps(root));
    case "check": return voiceCheck(checkDeps(root));
    case "timings": say("voice:timings: not available yet (the room-test timing record comes with a later task)"); return 2;
    default: say("usage: voice-ops up | down | check | timings"); return 2;
  }
}

main().then(
  (code) => {
    const sig = signals.signal();
    const line = lastLine(process.argv[2], sig, rollback); // "rolled back" only after a rollback that completed (review B2 F3)
    if (line !== null) say(line);
    process.exitCode = sig !== null ? exitCodeOf(sig) : code;
  },
  () => { say("voice-ops: failed (an unexpected error; nothing secret is printed)"); process.exitCode = 1; },
);
