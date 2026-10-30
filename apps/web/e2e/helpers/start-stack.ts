import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer, type RawData } from "ws";

// The whole participant stack on one machine, for the Playwright specs and `pnpm demo --web`:
//   browser -> `next start` (the BFF and pages, built beforehand) -> relay -> runtime (mock models, its own process, private data dir)
// The relay is a plain WebSocket pass-through between the BFF and the runtime. It exists for two test needs only: dropSocket(role)
// cuts one participant's runtime socket (the "drop" the BFF must recover from), and the runtime can restart on a new port while the
// BFF's RUNTIME_URL stays the same. It forwards X-Forwarded-For, close codes (4001 superseded) and handshake refusals unchanged.
//
// Nothing here measures time. Waits are on effects (a ready line, an HTTP answer, a frame), each with a generous upper bound.

export const SESSION_ID = "web-e2e";
/** The one client address every browser context and the demo send as X-Forwarded-For, standing in for what Caddy appends. */
export const CLIENT_ADDRESS = "127.0.0.1";

const WEB_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const SCENARIO = path.join(REPO_ROOT, "scenarios", "friday-escalation");
const TSX = path.join(WEB_DIR, "node_modules", ".bin", "tsx");
const NEXT = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const RUNTIME_CHILD = path.join(WEB_DIR, "e2e", "helpers", "runtime-child.ts");
/** Printed by runtime-child.ts (kept in step there). */
const READY_PREFIX = "ACR_RUNTIME_READY ";
/** Upper bounds for start-up waits: far above a loaded runner's real times; reached only when something is broken. */
export const START_TIMEOUT_MS = 90_000;
const FACILITATOR_TIMEOUT_MS = 30_000;

export type TerminalFacilitator = {
  /** Sends `start`; resolves when session.started arrives, rejects with the runtime's error code and message when it refuses. */
  start(): Promise<void>;
  /** Sends a facilitator command; resolves when its facilitator.command event arrives, rejects on the runtime's error. */
  command(c: unknown): Promise<void>;
  /** Every frame the facilitator has received since it (re)connected. */
  frames(): unknown[];
};

export type Stack = {
  baseUrl: string;
  /** The runtime's own address (changes when restartRuntime starts it on a new port). The BFF reaches it through the relay. */
  runtimeUrl: string;
  /** The player join codes the runtime issued; replaced in place when a restart issues new ones. */
  codes: Record<string, string>;
  /** The facilitator on the runtime's protocol, as the terminal client is (2a has no browser console). */
  terminalFacilitator: TerminalFacilitator;
  /** Kills `next start` and starts it again on the same port with the same COOKIE_KEYS. Resolves once it answers. */
  restartBff(): Promise<void>;
  /** Stops the runtime cleanly and starts it again on the same data dir (resume, or new codes for a log with nothing in it). */
  restartRuntime(): Promise<void>;
  /** Cuts every relayed runtime socket that joined as `role` (both ends, abnormally), as a network drop would. */
  dropSocket(role: string): void;
  stop(): Promise<void>;
};

export type StackOptions = {
  /** Where the runtime's data dir is made (default: the OS temp dir). */
  tempParent?: string;
  /** Diagnostic output of the child processes (default: discarded). Never carries codes, credentials, cookies or names. */
  onOutput?: (line: string) => void;
  /** Extra environment for `next start`, merged over the stack's own (RUNTIME_URL, PUBLIC_ORIGIN and COOKIE_KEYS cannot be overridden). */
  webEnv?: Record<string, string>;
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

/** Kills a detached child's whole process group and waits for it to exit. */
export async function killGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  await withTimeout(exited, START_TIMEOUT_MS, "a child process did not exit");
}

export const lines = (child: ChildProcess, sink: (l: string) => void) => {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { sink(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
  }
};

// ---- runtime ----

type RuntimeProc = { child: ChildProcess; port: number; codes: Record<string, string> };

async function startRuntime(dataRoot: string, out: (l: string) => void): Promise<RuntimeProc> {
  const env = {
    SCENARIO_DIR: SCENARIO, SESSION_ID, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", MODEL_PROVIDER: "mock", TRUST_PROXY: "1",
    // Every participant arrives from one address here (CLIENT_ADDRESS): the default 8 per address would be tight for 3 players, a second tab and the join sockets.
    WS_MAX_CONNECTIONS_PER_IP: "64",
  };
  const child = spawn(TSX, [RUNTIME_CHILD, JSON.stringify({ env, root: dataRoot, logDir: path.join(dataRoot, "sessions") })], {
    cwd: WEB_DIR, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" },
  });
  const ready = new Promise<{ port: number; codes: Record<string, string> }>((resolve, reject) => {
    lines(child, (l) => {
      if (l.startsWith(READY_PREFIX)) resolve(JSON.parse(l.slice(READY_PREFIX.length)) as { port: number; codes: Record<string, string> });
      else out(l);
    });
    child.once("exit", (code) => reject(new Error(`the runtime exited before it was ready (code ${code})`)));
    child.once("error", (e) => reject(new Error(`the runtime could not start: ${e.message}`)));
  });
  try {
    const r = await withTimeout(ready, START_TIMEOUT_MS, "the runtime");
    return { child, ...r };
  } catch (e) { await killGroup(child); throw e; }
}

/** Asks the runtime to stop (its stdin closes) and waits for it: a clean stop releases the session lock for the restart. */
async function stopRuntime(r: RuntimeProc): Promise<void> {
  if (r.child.exitCode !== null || r.child.signalCode !== null) return;
  const exited = new Promise<void>((res) => r.child.once("exit", () => res()));
  r.child.stdin?.end();
  try { await withTimeout(exited, START_TIMEOUT_MS, "the runtime did not stop"); }
  catch { await killGroup(r.child); }
}

// ---- relay ----

type Pair = { role: string | null; client: WebSocket | null; upstream: WebSocket };

/** A close code that may be sent on the wire (1005 and 1006 are reported, never sent). */
const sendable = (code: number) => code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
function closeLike(ws: WebSocket, code: number, reason: Buffer): void {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  if (code === 1006) ws.terminate();
  else if (sendable(code)) ws.close(code, reason);
  else ws.close();
}

function startRelay(target: () => string): Promise<{ port: number; pairs: Set<Pair>; close(): Promise<void> }> {
  const pairs = new Set<Pair>();
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const xff = req.headers["x-forwarded-for"];
    const upstream = new WebSocket(target(), { headers: typeof xff === "string" ? { "X-Forwarded-For": xff } : {} });
    const pair: Pair = { role: null, client: null, upstream };
    const early: { data: RawData; binary: boolean }[] = [];
    upstream.on("message", (data, binary) => { if (pair.client) pair.client.send(data, { binary }); else early.push({ data, binary }); });
    // A refused handshake (429, 503, 426) reaches the BFF as the same status.
    upstream.once("unexpected-response", (_r, res) => {
      socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      res.resume();
    });
    // Nothing listening (the runtime is restarting): the BFF sees a failed connection, as it would without the relay.
    upstream.once("error", () => { if (!pair.client) socket.destroy(); });
    upstream.once("open", () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        pair.client = client;
        pairs.add(pair);
        for (const m of early.splice(0)) client.send(m.data, { binary: m.binary });
        client.on("message", (data, binary) => {
          if (pair.role === null && !binary) {
            try { const m = JSON.parse(data.toString()) as { type?: unknown; roleId?: unknown }; if (m.type === "join" && typeof m.roleId === "string") pair.role = m.roleId; } catch { /* not ours to judge */ }
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        client.on("close", (code, reason) => { pairs.delete(pair); closeLike(upstream, code, reason); });
        client.on("error", () => upstream.terminate());
        upstream.on("close", (code, reason) => { pairs.delete(pair); closeLike(client, code, reason); });
        if (upstream.readyState !== WebSocket.OPEN) client.terminate();
      });
    });
    upstream.on("close", () => { if (!pair.client) socket.destroy(); });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as { port: number }).port,
      pairs,
      close: () => new Promise<void>((r) => {
        for (const p of pairs) { p.client?.terminate(); p.upstream.terminate(); }
        pairs.clear();
        wss.close();
        server.close(() => r());
        server.closeAllConnections();
      }),
    }));
  });
}

// ---- next start ----

/** What a Node process needs from the caller's environment to run at all; nothing that configures the app. */
export function passThrough(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT"]) { const v = process.env[k]; if (v !== undefined) out[k] = v; }
  return out;
}

export async function startNext(port: number, env: Record<string, string>, baseUrl: string, out: (l: string) => void): Promise<ChildProcess> {
  if (!existsSync(path.join(WEB_DIR, ".next", "BUILD_ID"))) throw new Error("apps/web has no production build: run `pnpm --filter @acr/web build` first (the e2e and demo scripts do)");
  const child = spawn(process.execPath, [NEXT, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"],
    // An explicit environment, never the caller's: no stray RUNTIME_URL, COOKIE_KEYS, WEB_* limit or proxy setting can reach the BFF.
    env: { ...passThrough(), ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  });
  lines(child, (l) => out(`next: ${l}`));
  let exited = false;
  child.once("exit", () => { exited = true; });
  const up = (async () => {
    for (;;) {
      if (exited) throw new Error("next start exited before it answered");
      try { if ((await fetch(`${baseUrl}/robots.txt`)).ok) return; } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 200)); // a poll interval, not an ordering assumption
    }
  })();
  try { await withTimeout(up, START_TIMEOUT_MS, "next start"); }
  catch (e) { await killGroup(child); throw e; }
  return child;
}

// ---- facilitator ----

function facilitatorFor(url: () => string): TerminalFacilitator & { close(): void } {
  let ws: WebSocket | null = null;
  let inbox: { type?: string; code?: string; message?: string; event?: { type?: string; command?: string } }[] = [];
  let waiters: (() => void)[] = [];
  const notify = () => { for (const w of waiters.slice()) w(); };
  const connect = async (): Promise<WebSocket> => {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    inbox = [];
    const sock = new WebSocket(url());
    sock.on("message", (d) => { inbox.push(JSON.parse(d.toString())); notify(); });
    sock.on("close", () => { if (ws === sock) ws = null; notify(); });
    await withTimeout(new Promise<void>((r, j) => { sock.once("open", () => r()); sock.once("error", j); }), FACILITATOR_TIMEOUT_MS, "the facilitator connection");
    ws = sock;
    sock.send(JSON.stringify({ type: "join_facilitator", sessionId: SESSION_ID }));
    await until(() => inbox.some((m) => m.type === "joined"), "the facilitator's joined");
    return sock;
  };
  const until = (pred: () => boolean, what: string) => withTimeout(new Promise<void>((resolve) => {
    const check = () => { if (pred()) { waiters = waiters.filter((w) => w !== check); resolve(); } };
    waiters.push(check);
    check();
  }), FACILITATOR_TIMEOUT_MS, what);
  /** Sends and waits for `done` or a runtime error frame (rejected as "code: message") among the frames after the send. */
  const exchange = async (m: unknown, done: (f: (typeof inbox)[number]) => boolean, what: string) => {
    const sock = await connect();
    const from = inbox.length;
    sock.send(JSON.stringify(m));
    let found: (typeof inbox)[number] | undefined;
    await until(() => (found = inbox.slice(from).find((f) => f.type === "error" || done(f))) !== undefined, what);
    if (found!.type === "error") throw new Error(`${found!.code}: ${found!.message}`);
  };
  return {
    start: () => exchange({ type: "start" }, (f) => f.type === "event" && f.event?.type === "session.started", "session.started"),
    command: (c) => {
      const name = (c as { command?: unknown }).command;
      return exchange({ type: "command", command: c }, (f) => f.type === "event" && f.event?.type === "facilitator.command" && f.event.command === name, `the ${String(name)} command`);
    },
    frames: () => inbox.slice(),
    close: () => { ws?.terminate(); ws = null; },
  };
}

// ---- the stack ----

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const out = o.onOutput ?? (() => {});
  const dataRoot = await mkdtemp(path.join(o.tempParent ?? os.tmpdir(), "acr-web-e2e-"));
  const cleanups: (() => Promise<void>)[] = [() => rm(dataRoot, { recursive: true, force: true })];
  const cleanup = async () => { for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined); };
  try {
    let runtime = await startRuntime(dataRoot, out);
    cleanups.push(() => stopRuntime(runtime));
    const codes: Record<string, string> = { ...runtime.codes };
    const relay = await startRelay(() => `ws://127.0.0.1:${runtime.port}`);
    cleanups.push(() => relay.close());

    const port = await freePort();
    const baseUrl = `http://localhost:${port}`;
    // Fresh keys per stack, the same across restartBff (a sealed cookie must survive a BFF restart).
    const nextEnv = { ...o.webEnv, RUNTIME_URL: `ws://127.0.0.1:${relay.port}`, PUBLIC_ORIGIN: baseUrl, COOKIE_KEYS: `e2e:${randomBytes(32).toString("base64")}` };
    let next = await startNext(port, nextEnv, baseUrl, out);
    cleanups.push(() => killGroup(next));

    const facilitator = facilitatorFor(() => `ws://127.0.0.1:${runtime.port}`);
    cleanups.push(async () => facilitator.close());

    const stack: Stack = {
      baseUrl,
      runtimeUrl: `ws://127.0.0.1:${runtime.port}`,
      codes,
      terminalFacilitator: { start: facilitator.start, command: facilitator.command, frames: facilitator.frames },
      async restartBff() {
        await killGroup(next);
        next = await startNext(port, nextEnv, baseUrl, out);
      },
      async restartRuntime() {
        facilitator.close();
        await stopRuntime(runtime);
        runtime = await startRuntime(dataRoot, out);
        stack.runtimeUrl = `ws://127.0.0.1:${runtime.port}`;
        // A start that issued codes (a log with nothing in it) replaces them all; a resume keeps the earlier ones.
        if (Object.keys(runtime.codes).length > 0) { for (const k of Object.keys(codes)) delete codes[k]; Object.assign(codes, runtime.codes); }
      },
      dropSocket(role) {
        for (const p of [...relay.pairs]) if (p.role === role) { p.client?.terminate(); p.upstream.terminate(); }
      },
      stop: cleanup,
    };
    return stack;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
