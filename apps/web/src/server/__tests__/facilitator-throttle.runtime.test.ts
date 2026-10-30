import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeConnection, RuntimeError } from "../runtime-connection";

// The real runtime, in-process, mock models, port 0, private temp dirs. Proves the claim facilitator-socket.ts rests on: a stale
// facilitator token costs only the BFF's own address, never a player's.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(
  new URL("../../../../../services/runtime/src/main.ts", import.meta.url),
);
if (!existsSync(MAIN))
  throw new Error(
    `facilitator-throttle.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`,
  );
const SCENARIO = fileURLToPath(
  new URL("../../../../../scenarios/friday-escalation", import.meta.url),
);
type Bootstrap = (o: {
  env: Record<string, string>;
  root: string;
  logDir: string;
  tickMs: number;
  log: (m: string) => void;
  warn: (m: string) => void;
  showJoinCodes: (c: { roleId: string; code: string }[]) => void;
}) => Promise<
  | { ok: true; runtime: { port: number; stop(): Promise<void> } }
  | { ok: false; errors: string[] }
>;

const SESSION = "web-fac-throttle";
const TOKEN = "f".repeat(64);
/** The runtime's DEFAULT_LIMITS.maxAuthFailures (host/security.ts): MORE than this many failures in the window block the address. */
const MAX_AUTH_FAILURES = 5;

let tmp = "";
let runtime: { port: number; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let conns: RuntimeConnection[] = [];
const url = () => `ws://127.0.0.1:${runtime!.port}`;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-facthr-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  codes = {};
  const r = await bootstrap({
    env: {
      SCENARIO_DIR: SCENARIO,
      RUNTIME_PORT: "0",
      RUNTIME_HOST: "127.0.0.1",
      SESSION_ID: SESSION,
      MODEL_PROVIDER: "mock",
      TRUST_PROXY: "1",
      FACILITATOR_TOKEN: TOKEN,
    },
    root: tmp,
    logDir: tmp,
    tickMs: 60_000,
    log: () => {},
    warn: () => {},
    showJoinCodes: (c) => {
      for (const x of c) codes[x.roleId] = x.code;
    },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
});
afterEach(async () => {
  for (const c of conns) c.close();
  conns = [];
  await runtime?.stop();
  runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

describe("refused facilitator tokens and the runtime's per-address throttle", () => {
  it("maxAuthFailures stale facilitator tokens over sockets without X-Forwarded-For do not block a player upgrade carrying X-Forwarded-For 203.0.113.5", async () => {
    // The facilitator's own socket works with the real token (and shows the open path is the one under test).
    const ok = await RuntimeConnection.connect(url(), null);
    conns.push(ok);
    expect((await ok.joinFacilitator(SESSION, TOKEN)).status).toBe("idle");

    for (let i = 0; i < MAX_AUTH_FAILURES + 1; i++) {
      const stale = await RuntimeConnection.connect(url(), null);
      conns.push(stale);
      await expect(
        stale.joinFacilitator(SESSION, `stale-${i}-${"x".repeat(32)}`),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
    // The BFF's own (loopback) address is now blocked: the throttle did fire, so the next part is not vacuous.
    await expect(RuntimeConnection.connect(url(), null)).rejects.toMatchObject({
      code: "rate_limited",
    });

    // A player's upgrade carries the player's address: not blocked, and a real join by code succeeds.
    const player = await RuntimeConnection.connect(url(), "203.0.113.5");
    conns.push(player);
    const joined = await player.joinWithCode({
      sessionId: SESSION,
      roleId: "tech_lead",
      participantId: "p-throttle",
      joinCode: codes.tech_lead!,
      displayName: "Ann",
    });
    expect(joined.roleId).toBe("tech_lead");
    expect(joined.credential).toBeTypeOf("string");
  });

  it("the same stale tokens WITH the player's X-Forwarded-For would have blocked that player (why facilitator sockets send none)", async () => {
    for (let i = 0; i < MAX_AUTH_FAILURES + 1; i++) {
      const stale = await RuntimeConnection.connect(url(), "203.0.113.5");
      conns.push(stale);
      await expect(
        stale.joinFacilitator(SESSION, `stale-${i}-${"x".repeat(32)}`),
      ).rejects.toBeInstanceOf(RuntimeError);
    }
    await expect(
      RuntimeConnection.connect(url(), "203.0.113.5"),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
