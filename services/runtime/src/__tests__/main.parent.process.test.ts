import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(here, "../..");
const entry = path.join(runtimeDir, "src/main.ts");

describe("the runtime forked the way the control service forks it (US-0058)", () => {
  it("sends codes then ready over IPC, and exits 0 when the parent disconnects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-proc-"));
    let child: ChildProcess | undefined;
    try {
      const messages: { type: string; port?: number }[] = [];
      let exited: number | null | undefined;
      child = fork(entry, [], {
        cwd: runtimeDir, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH ?? "", CONTROL_MANAGED: "1", SESSION_ID: `proc-${randomBytes(4).toString("hex")}`, SESSION_DATA_DIR: path.join(dir, "sessions"),
          MODEL_PROVIDER: "mock", RUNTIME_HOST: "127.0.0.1", RUNTIME_PORT: "0", FACILITATOR_TOKEN: randomBytes(32).toString("hex"),
        },
      });
      child.on("message", (m) => messages.push(m as { type: string; port?: number }));
      child.on("exit", (code) => { exited = code; });
      await vi.waitFor(() => expect(messages.map((m) => m.type)).toEqual(["codes", "ready"]), { timeout: 45_000, interval: 50 });
      expect(messages[1]!.port).toBeGreaterThan(0);
      child.disconnect();
      await vi.waitFor(() => expect(exited).toBe(0), { timeout: 15_000, interval: 50 });
    } finally {
      child?.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
