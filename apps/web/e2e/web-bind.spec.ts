import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, killGroup, passThrough, START_TIMEOUT_MS, withTimeout } from "./helpers/start-stack";

// US-0072 (EPIC-0003 voice A1c, Task 6, AC-0421): the web package's own `start` script listens on loopback only, so a LAN client cannot
// reach the BFF around the TLS proxy (and choose its own X-Forwarded-For key, see guards.test.ts). The spec starts `next start` with
// exactly the script's arguments (from apps/web/package.json) on a free port, waits until 127.0.0.1 answers HTTP, then opens a TCP
// connection to this machine's first non-internal IPv4 address on the same port: it must be refused. No browser is used. Nothing here
// measures time; every wait has a generous upper bound.

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const NEXT = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");

/** The first non-internal IPv4 address of this machine, or null. */
function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if ((i.family === "IPv4" || (i.family as unknown) === 4) && !i.internal) return i.address;
  }
  return null;
}

/** "open" when a TCP connection is accepted, "refused" for ECONNREFUSED, otherwise the error code (or "timeout"). */
function tcpConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 15_000); // an upper bound only: a refusal is immediate
    s.once("connect", () => { clearTimeout(t); s.destroy(); resolve("open"); });
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); resolve(e.code === "ECONNREFUSED" ? "refused" : (e.code ?? "error")); });
  });
}

test("the start script binds loopback: a LAN address is refused", async () => {
  test.setTimeout(180_000);
  const script = (JSON.parse(readFileSync(path.join(WEB_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts.start!;
  const words = script.split(" ");
  expect(words.slice(0, 2)).toEqual(["next", "start"]);
  const lan = lanAddress();
  test.skip(lan === null, "no non-loopback IPv4 address on this machine");

  const port = await freePort();
  const env = {
    ...passThrough(), NODE_ENV: "production" as const, NEXT_TELEMETRY_DISABLED: "1",
    COOKIE_KEYS: `e2e:${randomBytes(32).toString("base64")}`, PUBLIC_ORIGIN: `http://localhost:${port}`, RUNTIME_URL: "ws://127.0.0.1:1",
  };
  const child = spawn(process.execPath, [NEXT, ...words.slice(1), "-p", String(port)], { cwd: WEB_DIR, detached: true, stdio: "ignore", env });
  try {
    let exited = false;
    child.once("exit", () => { exited = true; });
    await withTimeout((async () => {
      for (;;) {
        if (exited) throw new Error("next start exited before it answered");
        try { if ((await fetch(`http://127.0.0.1:${port}/robots.txt`)).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 200)); // a poll interval, not an ordering assumption
      }
    })(), START_TIMEOUT_MS, "next start");
    expect(await tcpConnect("127.0.0.1", port)).toBe("open");
    expect(await tcpConnect(lan!, port)).toBe("refused");
    expect(script).toBe("next start -H 127.0.0.1"); // pinned: an added flag must be reviewed against this spec
  } finally {
    await killGroup(child);
  }
});
