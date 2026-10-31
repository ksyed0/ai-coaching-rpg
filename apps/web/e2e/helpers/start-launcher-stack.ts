import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  /** SIGTERMs the control service (its runtimes exit when the IPC channel closes), waits, and starts it again on the same port, data dir and token. */
  restartControl(): Promise<void>;
  /** Kills `next start` and starts it again on the same port with the same COOKIE_KEYS. */
  restartBff(): Promise<void>;
  /** Stops everything and removes the temp dir. */
  stop(): Promise<void>;
};

export type LauncherStackOptions = {
  /** Diagnostic output of the child processes (default: discarded). Never carries codes, credentials, cookies or names. */
  onOutput?: (line: string) => void;
};

async function startControl(
  port: number,
  dataDir: string,
  token: string,
  out: (l: string) => void,
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
    let control = await startControl(controlPort, dataDir, serviceToken, out);
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
    };
    let next = await startNext(port, nextEnv, baseUrl, out);
    cleanups.push(() => killGroup(next));

    return {
      baseUrl,
      controlUrl,
      serviceToken,
      facilitatorSecret,
      async restartControl() {
        await stopControl(control);
        control = await startControl(controlPort, dataDir, serviceToken, out);
      },
      async restartBff() {
        await killGroup(next);
        next = await startNext(port, nextEnv, baseUrl, out);
      },
      stop: cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
