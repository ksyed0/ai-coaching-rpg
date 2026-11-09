import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { StreamHub, VOICE_NOTICE_CODES, type SessionCookie } from "../stream-hub";
import type { JoinedFrame } from "../wire";
import { sseRecorder, until } from "./fakes";

// US-0071 (A1b Task 11): the hub's voice frames against the REAL runtime with voice on (VOICE_ENABLED=1, managed by a fake parent channel,
// notice v3). In-process, mock models, port 0, a private temp directory. Generous explicit limits; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Loaded by a computed path: tsc would otherwise type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
const VOICE = fileURLToPath(new URL("../../../../../services/runtime/src/host/voice.ts", import.meta.url));
if (!existsSync(MAIN) || !existsSync(VOICE)) throw new Error("hub.voice.runtime.test.ts needs the runtime's main.ts and host/voice.ts; they moved: update the paths");
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));
const CONSENT = fileURLToPath(new URL("../../../../../consent", import.meta.url));

const SESSION = "web-voice";
const ROLE = "tech_lead";
type ParentMessage = { type: string; [k: string]: unknown };
type Parent = { send(m: unknown): boolean; onMessage(fn: (m: ParentMessage) => void): void; onDisconnect(fn: () => void): void };
type Runtime = { port: number; stop(): Promise<void> };
type Bootstrap = (o: { env: Record<string, string>; root: string; consentDir: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; parent: Parent; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: Runtime } | { ok: false; errors: string[] }>;

let parentTmp = "";
let savedTmp: string | undefined;
let tmp = "";
let runtime: Runtime | null = null;
let codes: Record<string, string> = {};
let toRuntime: ((m: ParentMessage) => void) | undefined;
let hub: StreamHub;
let closers: (() => void)[] = [];
const url = () => `ws://127.0.0.1:${runtime!.port}`;

beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-voice-")); process.env.TMPDIR = parentTmp; });
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });

beforeEach(async () => {
  tmp = await mkdtemp(path.join(parentTmp, "run-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  codes = {};
  const parent: Parent = { send: () => true, onMessage: (fn) => { toRuntime = fn; }, onDisconnect: () => {} };
  const r = await bootstrap({
    env: { SCENARIO_DIR: SCENARIO, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: SESSION, MODEL_PROVIDER: "mock", TRUST_PROXY: "1", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3", VOICE_ENABLED: "1", SESSION_DATA_DIR: path.join(tmp, "sessions") },
    root: tmp, consentDir: CONSENT, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
    showJoinCodes: (c) => { for (const x of c) codes[x.roleId] = x.code; },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
  hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
});
afterEach(async () => {
  for (const c of closers) c();
  closers = [];
  await runtime?.stop(); runtime = null;
});

async function seat(role = ROLE, participantId = `${role}-person`) {
  const code = await RuntimeConnection.connect(url(), "198.51.100.21");
  const first = await code.joinWithCode({ sessionId: SESSION, roleId: role, participantId, joinCode: codes[role]!, displayName: `Name ${role}` });
  code.close();
  const cookie: SessionCookie = { sessionId: SESSION, roleId: role, participantId, credential: first.credential!, logIdentity: first.logIdentity!, expiresAt: Date.now() + 3_600_000 };
  const conn = await RuntimeConnection.connect(url(), "198.51.100.21");
  const joined: JoinedFrame = await conn.joinWithCredential({ sessionId: SESSION, roleId: role, participantId, credential: cookie.credential, lastSeq: 0 });
  const rec = sseRecorder();
  const handle = hub.open(cookie, "198.51.100.21", conn, joined, rec.out);
  if (handle === "capacity") throw new Error("unexpected capacity");
  closers.push(() => handle.close());
  return { cookie, joined, rec };
}

describe("StreamHub voice against the real runtime (VOICE_ENABLED=1)", () => {
  it("the BFF's voice notice codes equal the runtime's VOICE_NOTICE_CODES", async () => {
    const { VOICE_NOTICE_CODES: runtimeCodes } = (await import(VOICE)) as { VOICE_NOTICE_CODES: readonly string[] };
    expect([...VOICE_NOTICE_CODES]).toEqual([...runtimeCodes]);
  });

  it("joined carries this seat's voice state and mute through the hub", async () => {
    const s = await seat();
    expect(s.rec.frames()[1]!.data.voice).toEqual({ state: "none", muted: false });
  });

  it("opt in through the hub answers state voice; mute answers muted true; opt out answers text_only", async () => {
    const s = await seat();
    expect(await hub.send(s.cookie, { type: "consent", noticeVersion: "v3" })).toBeNull();
    expect(await hub.send(s.cookie, { type: "voice_opt_in", noticeVersion: "v3" })).toEqual({ type: "voice", state: "voice", muted: false });
    expect(await hub.send(s.cookie, { type: "voice_mute", muted: true })).toEqual({ type: "voice", state: "voice", muted: true });
    expect(await hub.send(s.cookie, { type: "voice_opt_out" })).toEqual({ type: "voice", state: "text_only", muted: true });
    // The answers went to the waiting sends, never to the page as frames.
    expect(s.rec.frames().filter((f) => f.event === "voice")).toEqual([]);
  });

  it("a refused opt-in (an old notice version) is the send's error answer", async () => {
    const s = await seat();
    expect(await hub.send(s.cookie, { type: "voice_opt_in", noticeVersion: "v2" })).toMatchObject({ type: "error", code: "consent_version" });
  });

  it("voice_availability false sends voice_unavailable to the voice holder's stream only, as a named event", async () => {
    const holder = await seat();
    const peer = await seat("delivery_lead");
    expect(await hub.send(holder.cookie, { type: "consent", noticeVersion: "v3" })).toBeNull();
    expect(await hub.send(holder.cookie, { type: "voice_opt_in", noticeVersion: "v3" })).toMatchObject({ state: "voice" });
    toRuntime!({ type: "voice_availability", available: false, off: false });
    await until(() => holder.rec.frames().some((f) => f.event === "voice_notice"), { what: "the voice_unavailable notice" });
    expect(holder.rec.frames().filter((f) => f.event === "voice_notice")).toEqual([{ event: "voice_notice", data: { code: "voice_unavailable" } }]);
    toRuntime!({ type: "voice_availability", available: true, off: false });
    await until(() => holder.rec.frames().filter((f) => f.event === "voice_notice").length === 2, { what: "the voice_available notice" });
    expect(holder.rec.frames().filter((f) => f.event === "voice_notice").at(-1)).toEqual({ event: "voice_notice", data: { code: "voice_available" } });
    // The other player never learns anything about the holder's voice, in any frame.
    const peerText = peer.rec.chunks.join("");
    expect(peerText).not.toContain("voice_notice");
    expect(peerText).not.toContain("voice_unavailable");
    for (const f of peer.rec.frames().filter((x) => x.event === "roster")) for (const e of f.data.entries) expect(Object.keys(e).sort()).toEqual(expect.not.arrayContaining(["voice", "speaking"]));
  });
});
