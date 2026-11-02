import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FACILITATOR_FORWARD_KEY } from "../facilitator-budget";
import { RuntimeConnection } from "../runtime-connection";

// The real runtime, in-process, mock models, port 0, private temp dirs. Proves the claim facilitator-socket.ts rests on: a stale
// facilitator token costs only the console's reserved X-Forwarded-For key, never a player's address.
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
      WS_MAX_CONNECTIONS_PER_IP: "8",
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

const KEY = FACILITATOR_FORWARD_KEY;
const PLAYER = "203.0.113.5";

async function staleOn(key: string, n: number) {
  for (let i = 0; i < n; i++) {
    const stale = await RuntimeConnection.connect(url(), key);
    conns.push(stale);
    await expect(
      stale.joinFacilitator(SESSION, `stale-${i}-${"x".repeat(32)}`),
    ).rejects.toMatchObject({ code: "unauthorized" });
  }
}
async function playerJoin(address: string) {
  const player = await RuntimeConnection.connect(url(), address);
  conns.push(player);
  const joined = await player.joinWithCode({
    sessionId: SESSION,
    roleId: "tech_lead",
    participantId: `p-${address}`,
    joinCode: codes.tech_lead!,
    displayName: "Ann",
  });
  expect(joined.roleId).toBe("tech_lead");
}

describe("refused facilitator tokens and the runtime's per-address throttle", () => {
  it("MAX_AUTH_FAILURES + 1 stale tokens on the console key do not block a player upgrade with X-Forwarded-For 203.0.113.5 nor one with 127.0.0.1", async () => {
    // The facilitator's own socket works with the real token (and shows the open path is the one under test).
    const ok = await RuntimeConnection.connect(url(), KEY);
    conns.push(ok);
    expect((await ok.joinFacilitator(SESSION, TOKEN)).status).toBe("idle");

    await staleOn(KEY, MAX_AUTH_FAILURES + 1);
    // The console key is now blocked: the throttle did fire, so the next part is not vacuous.
    await expect(RuntimeConnection.connect(url(), KEY)).rejects.toMatchObject({
      code: "rate_limited",
    });

    await playerJoin(PLAYER);
    // A player claiming the loopback address is a different key from the console's.
    const loop = await RuntimeConnection.connect(url(), "127.0.0.1");
    conns.push(loop);
    expect(loop.isOpen).toBe(true);
  });

  it("eight player sockets claiming 127.0.0.1 do not stop a facilitator join on the console key", async () => {
    for (let i = 0; i < 8; i++)
      conns.push(await RuntimeConnection.connect(url(), "127.0.0.1"));
    const fac = await RuntimeConnection.connect(url(), KEY);
    conns.push(fac);
    expect((await fac.joinFacilitator(SESSION, TOKEN)).status).toBe("idle");
  });

  it("stale tokens on the console key do not block an upgrade on scenecoach-bot", async () => {
    await staleOn(KEY, MAX_AUTH_FAILURES + 1);
    await expect(RuntimeConnection.connect(url(), KEY)).rejects.toMatchObject({
      code: "rate_limited",
    });
    const bot = await RuntimeConnection.connect(url(), "scenecoach-bot");
    conns.push(bot);
    expect(bot.isOpen).toBe(true);
  });

  it("a ninth socket on one key is refused 503 while another key still connects", async () => {
    for (let i = 0; i < 8; i++)
      conns.push(await RuntimeConnection.connect(url(), KEY));
    await expect(RuntimeConnection.connect(url(), KEY)).rejects.toMatchObject({
      code: "unavailable",
    });
    const other = await RuntimeConnection.connect(url(), PLAYER);
    conns.push(other);
    expect(other.isOpen).toBe(true);
  });
});
