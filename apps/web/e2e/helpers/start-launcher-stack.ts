import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  REPO_ROOT,
  START_TIMEOUT_MS,
  freePort,
  killGroup,
  lines,
  passThrough,
  startNext,
  withTimeout,
} from "./start-stack";

// The launcher-mode stack on one machine, for the console specs:
//   browser -> `next start` (LAUNCHER_URL, no RUNTIME_URL) -> control service (mock models, temp data dir) -> one runtime per session
// The control service is the real one (`tsx src/main.ts` from services/control); the runtimes are its own children. Nothing here
// measures time: waits are on effects (the service's startup line, an HTTP answer) with generous upper bounds.

const CONTROL_DIR = path.join(REPO_ROOT, "services", "control");
const TSX = path.join(CONTROL_DIR, "node_modules", ".bin", "tsx");
/** Printed by services/control/src/main.ts when it listens (kept in step there). */
const LISTENING = /^control service listening on 127\.0\.0\.1:(\d+)$/;

export type LauncherStack = {
  /** The origin every browser uses (and PUBLIC_ORIGIN). */
  baseUrl: string;
  controlUrl: string;
  serviceToken: string;
  facilitatorSecret: string;
  /** The control service's data dir (a temp dir this stack owns, removed by stop()); report folders go under `reports/`. */
  dataDir: string;
  /** SIGTERMs the control service (its runtimes exit when the IPC channel closes), waits, and starts it again on the same port, data dir and token. */
  restartControl(): Promise<void>;
  /** Kills `next start` and starts it again on the same port with the same COOKIE_KEYS. */
  restartBff(): Promise<void>;
  /**
   * SIGKILLs every session runtime (a runtime crash, as opposed to the clean stop of restartControl): each process of the control
   * service's process group whose command line holds the runtime entry. Throws when none matched, so a changed entry path fails
   * loudly instead of passing without a crash. Resolves once the control service lists the session as `stopped`.
   */
  crashRuntimes(): Promise<void>;
  /** How many session runtimes run now (processes of the control service's group whose command line holds the runtime entry). */
  runtimeCount(): Promise<number>;
  /** US-0071: the web server's LIVEKIT_URL origin (`ws://127.0.0.1:<port>`, a port nothing listens on), when the stack has one. */
  livekitOrigin?: string;
  /**
   * US-0071: the fake speech-to-text's call record (`<script>.calls.jsonl`: one `{"roleId","n"}` line per transcription, never text),
   * when the stack has voice. It may not exist before the first call.
   */
  sttCalls?: string;
  /**
   * US-0071: SIGKILLs every speech worker of the control service's group (each process whose command line holds the speech entry);
   * waits up to the start timeout for one to exist first. The control service restarts them by itself (bounded backoff).
   */
  crashSpeechWorkers(): Promise<void>;
  /** Stops everything and removes the temp dir. */
  stop(): Promise<void>;
};

export type LauncherStackOptions = {
  /** Diagnostic output of the child processes (default: discarded). Never carries codes, credentials, cookies or names. */
  onOutput?: (line: string) => void;
  /**
   * US-0071 (A1b Task 17): voice on in the control service (VOICE_ENABLED=1, notice v3, the fake speech-to-text with an empty script,
   * the file ingest with an empty directory: no audio is ever read) and, unless `livekitUrl` is false, LIVEKIT_URL in the web server
   * set to a loopback port nothing listens on (an explicit port, as the web config requires). No LiveKit key or secret is set anywhere:
   * the control service then answers every token request `voice_unavailable` (it issues tokens only with SPEECH_INGEST=livekit), and
   * no LiveKit server exists in the e2e run. The opt-in live spec (`voice-live.spec.ts`, VOICE_LIVE=1) sets `live` instead.
   */
  voice?: {
    livekitUrl?: boolean;
    /**
     * US-0071 (A1b Task 18, opt-in live checks only): a REAL LiveKit server. The control service then runs SPEECH_INGEST=livekit with
     * these keys and LIVEKIT_HOST (its speech workers subscribe to the seat rooms), and the web server's LIVEKIT_URL is `url`. Never
     * set in the default suite (no LiveKit server there).
     */
    live?: { url: string; host: string; apiKey: string; apiSecret: string };
    /** The fake speech-to-text script: role id -> the lines its segments give, in order (default: none, every segment is empty). */
    sttLines?: Record<string, string[]>;
  };
};

/** The voice settings of the control service (US-0071): every path is inside `dir`, a private temp directory of this stack. */
async function voiceEnv(dir: string, v: NonNullable<LauncherStackOptions["voice"]>): Promise<{ env: Record<string, string>; script: string }> {
  const script = path.join(dir, "stt-script.json");
  await writeFile(script, JSON.stringify(v.sttLines ?? {}), { mode: 0o600 });
  const common = { VOICE_ENABLED: "1", CONSENT_NOTICE_VERSION: "v3", STT_PROVIDER: "fake", STT_FAKE_SCRIPT: script };
  if (v.live) {
    return {
      script,
      env: { ...common, SPEECH_INGEST: "livekit", LIVEKIT_API_KEY: v.live.apiKey, LIVEKIT_API_SECRET: v.live.apiSecret, LIVEKIT_HOST: v.live.host },
    };
  }
  const ingest = path.join(dir, "ingest");
  await mkdir(ingest, { mode: 0o700 });
  return { script, env: { ...common, SPEECH_INGEST: "file", SPEECH_INGEST_DIR: ingest } };
}

async function startControl(
  port: number,
  dataDir: string,
  token: string,
  out: (l: string) => void,
  extra: Record<string, string> = {},
): Promise<ChildProcess> {
  // An explicit environment, never the caller's: no provider key, token or proxy setting of the shell reaches the service or its runtimes.
  const env: Record<string, string> = {
    ...passThrough(),
    NO_COLOR: "1",
    CONTROL_PORT: String(port),
    LAUNCHER_TOKEN: token,
    CONTROL_DATA_DIR: dataDir,
    MODEL_PROVIDER: "mock",
    CONTROL_GRACE_MS: "2000",
    CONTROL_READY_TIMEOUT_MS: "60000",
    // US-0060: an AI player answers at once and never nudges on its own during a test (a stray quiet-time line would be a line no
    // assertion expects); the only lines it speaks are replies to a human line and the ones the facilitator prompts.
    AI_PLAYER_SETTLE_MS: "0",
    AI_PLAYER_MIN_GAP_MS: "0",
    AI_PLAYER_NUDGE_MS: "600000",
    ...extra,
  };
  const child: ChildProcess = spawn(TSX, ["src/main.ts"], {
    cwd: CONTROL_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
  });
  const listening = new Promise<void>((resolve, reject) => {
    lines(child, (l) => {
      if (LISTENING.test(l)) resolve();
      else out(`control: ${l}`);
    });
    child.once("exit", (code) =>
      reject(
        new Error(
          `the control service exited before it listened (code ${code})`,
        ),
      ),
    );
    child.once("error", (e) =>
      reject(new Error(`the control service could not start: ${e.message}`)),
    );
  });
  try {
    await withTimeout(listening, START_TIMEOUT_MS, "the control service");
    // The startup line is printed before the first request is served; an answer proves the API is up.
    await withTimeout(
      (async () => {
        for (;;) {
          try {
            if (
              (
                await fetch(`http://127.0.0.1:${port}/scenarios`, {
                  headers: { "X-Service-Token": token },
                })
              ).ok
            )
              return;
          } catch {
            /* not answering yet */
          }
          await new Promise((r) => setTimeout(r, 200)); // a poll interval, not an ordering assumption
        }
      })(),
      START_TIMEOUT_MS,
      "the control service's API",
    );
  } catch (e) {
    await killGroup(child);
    throw e;
  }
  return child;
}

/** Asks the control service to stop (SIGTERM, only to it: it disconnects its runtimes) and waits; a stuck one is killed with its group. */
async function stopControl(child: ChildProcess): Promise<void> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  )
    return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  try {
    await withTimeout(
      exited,
      START_TIMEOUT_MS,
      "the control service did not stop",
    );
  } catch {
    await killGroup(child);
  }
  // The runtimes were its children, in its process group: none may outlive it.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* the group is empty */
  }
}

const run = promisify(execFile);
/** The entry `services/control/src/runtime-command.ts` resolves for every runtime it forks. */
const RUNTIME_ENTRY = path.join(REPO_ROOT, "services/runtime/src/main.ts");
/** The entry `services/control/src/voice/speech-command.ts` resolves for every speech worker it forks (US-0071). */
const SPEECH_ENTRY = path.join(REPO_ROOT, "services/speech/src/main.ts");

/** The pids in process group `pgid` whose command line contains `entry`. `-ww`: BSD ps otherwise cuts args to a column width. */
async function runtimePids(pgid: number, entry = RUNTIME_ENTRY): Promise<number[]> {
  const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,pgid=,args="], { maxBuffer: 16 * 1024 * 1024 });
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[2]) === pgid && m[3]!.includes(entry)) out.push(Number(m[1]));
  }
  return out;
}

async function crashRuntimesOf(control: ChildProcess, controlUrl: string, token: string): Promise<void> {
  if (control.pid === undefined) throw new Error("the control service is not running");
  const pids = await runtimePids(control.pid);
  if (pids.length === 0) throw new Error(`no process of the control service's group runs ${RUNTIME_ENTRY}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  await withTimeout(
    (async () => {
      for (;;) {
        try {
          const r = await fetch(`${controlUrl}/sessions`, { headers: { "X-Service-Token": token } });
          if (r.ok) {
            const body = (await r.json()) as unknown;
            const list = (body as { data?: { status?: string }[] }).data; // the control API's envelope: { success, data, error }
            if (Array.isArray(list) && list.length > 0 && list.every((s) => s.status === "stopped")) return;
          }
        } catch {
          /* not answering yet */
        }
        await new Promise((r) => setTimeout(r, 200)); // a poll interval, not an ordering assumption
      }
    })(),
    START_TIMEOUT_MS,
    "the control service did not report the crashed session as stopped",
  );
}

async function crashSpeechOf(control: ChildProcess): Promise<void> {
  const pgid = control.pid;
  if (pgid === undefined) throw new Error("the control service is not running");
  const pids = await withTimeout(
    (async () => {
      for (;;) {
        const found = await runtimePids(pgid, SPEECH_ENTRY);
        if (found.length > 0) return found;
        await new Promise((r) => setTimeout(r, 200)); // a poll interval, not an ordering assumption
      }
    })(),
    START_TIMEOUT_MS,
    `no process of the control service's group runs ${SPEECH_ENTRY}`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
}

export async function startLauncherStack(
  o: LauncherStackOptions = {},
): Promise<LauncherStack> {
  const out = o.onOutput ?? (() => {});
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-launcher-e2e-"));
  const cleanups: (() => Promise<void>)[] = [
    () => rm(dataDir, { recursive: true, force: true }),
  ];
  const cleanup = async () => {
    for (const c of cleanups.splice(0).reverse())
      await c().catch(() => undefined);
  };
  try {
    const serviceToken = randomBytes(20).toString("hex"); // 40 characters
    const facilitatorSecret = randomBytes(12).toString("hex"); // 24 characters
    const controlPort = await freePort();
    const controlUrl = `http://127.0.0.1:${controlPort}`;
    let controlExtra: Record<string, string> = {};
    let livekitOrigin: string | undefined;
    let sttScript: string | undefined;
    if (o.voice) {
      const voiceDir = await mkdtemp(path.join(os.tmpdir(), "acr-voice-e2e-"));
      cleanups.push(() => rm(voiceDir, { recursive: true, force: true }));
      const v = await voiceEnv(voiceDir, o.voice);
      controlExtra = v.env;
      sttScript = v.script;
      // A port that was free a moment ago and that nothing here listens on: every LiveKit connection to it fails (unless live).
      if (o.voice.live) livekitOrigin = o.voice.live.url;
      else if (o.voice.livekitUrl !== false) livekitOrigin = `ws://127.0.0.1:${await freePort()}`;
    }
    let control = await startControl(controlPort, dataDir, serviceToken, out, controlExtra);
    cleanups.push(() => stopControl(control));

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    // Fresh keys per stack, the same across restartBff (a sealed cookie must survive a BFF restart). No RUNTIME_URL: launcher mode.
    const nextEnv = {
      LAUNCHER_URL: controlUrl,
      LAUNCHER_TOKEN: serviceToken,
      FACILITATOR_SECRET: facilitatorSecret,
      PUBLIC_ORIGIN: baseUrl,
      COOKIE_KEYS: `e2e:${randomBytes(32).toString("base64")}`,
      ...(livekitOrigin !== undefined && { LIVEKIT_URL: livekitOrigin }),
    };
    let next = await startNext(port, nextEnv, baseUrl, out);
    cleanups.push(() => killGroup(next));

    return {
      baseUrl,
      controlUrl,
      serviceToken,
      facilitatorSecret,
      dataDir,
      async restartControl() {
        await stopControl(control);
        control = await startControl(controlPort, dataDir, serviceToken, out, controlExtra);
      },
      async restartBff() {
        await killGroup(next);
        next = await startNext(port, nextEnv, baseUrl, out);
      },
      crashRuntimes: () => crashRuntimesOf(control, controlUrl, serviceToken),
      runtimeCount: async () => (control.pid === undefined ? 0 : (await runtimePids(control.pid)).length),
      ...(livekitOrigin !== undefined && { livekitOrigin }),
      ...(sttScript !== undefined && { sttCalls: `${sttScript}.calls.jsonl` }),
      crashSpeechWorkers: () => crashSpeechOf(control),
      stop: cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
