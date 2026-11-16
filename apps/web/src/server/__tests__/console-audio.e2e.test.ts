import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_REFUSALS } from "../../lib/messages";
import { handleConsoleAudioDelete, handleConsoleAudioList, handleConsoleAudioPlay } from "../console-audio-handlers";
import { setEnvelopeClock } from "../envelope";
import { LauncherClient, LauncherError } from "../launcher-client";
import type { Deps } from "../handlers";
import { ADMIN, FIXTURE_ORIGIN as ORIGIN, FIXTURE_T0 as T0, accountCookie, consoleAuth, fakeDeps, legacyCookie } from "../test-support/console-fixtures";
import { manualTimers } from "./fakes";

// A2b-2 Task 7: the three audio handlers behind a REAL LauncherClient against a REAL in-process control `createApi` over real loopback
// HTTP, with a REAL speech AudioStore, AuditLog and a temp session log. apps/web has no `@acr/control` dependency, so control is loaded by
// computed paths (as ai-roles.runtime.test.ts does). The real control here has no accounts service, so the console's auth and ownership
// lookups (`accountCheck`, `legacyAllowed`, `session`) are answered by a fronting fake; everything under /audio and /transcript goes to control.

const CONTROL_SRC = (rel: string) => fileURLToPath(new URL(`../../../../../services/control/src/${rel}`, import.meta.url));
const [{ createApi }, { buildAudioService }, { TranscriptService }, { AuditLog }, harness] = await Promise.all([
  import(CONTROL_SRC("api.ts")), import(CONTROL_SRC("main.ts")), import(CONTROL_SRC("voice/transcript.ts")), import(CONTROL_SRC("voice/audit-log.ts")),
  import(CONTROL_SRC("__tests__/voice/audio-e2e-harness.ts")),
]) as any[];

const h = harness.useAudioE2e("acr-web-audio-e2e-");
const { TOKEN, T0: CT0, A } = harness as { TOKEN: string; T0: number; A: string };

const ENDED = "s-1111111111111111";
const RUNNING = "s-2222222222222222";
const ALICE = "alice", BOB = "bob";

let servers: http.Server[] = [];
let seen: string[];
let launcher: LauncherClient;
let deps: Deps;
let timers: ReturnType<typeof manualTimers>;

const utt = (sessionId: string, seq: number, roleId: string, text: string) => ({ type: "utterance", seq, ts: CT0 + seq, sessionId, roleId, text, channel: "voice" });
const writeLog = (sessionId: string, events: unknown[]) =>
  writeFileSync(path.join(h.ctx.sessionsDir, `${sessionId}.jsonl`), [{ type: "session.started", sessionId }, ...events].map((e) => `${JSON.stringify(e)}\n`).join(""));

/** Control's REAL api (audio and transcript services) on an ephemeral port; every request path it receives is recorded in `seen`. */
async function startControl(status: (id: string) => "ended" | "not_ended" | "unknown"): Promise<string> {
  const audit = new AuditLog({ audioDir: h.ctx.audioDir, now: () => CT0 + 5, log: () => {} });
  const audio = buildAudioService({ audioDir: h.ctx.audioDir, sessionsDir: h.ctx.sessionsDir }, { audit });
  const transcript = new TranscriptService({ sessionsDir: h.ctx.sessionsDir, status, isLive: () => false });
  const api = createApi({
    config: { serviceToken: TOKEN }, supervisor: new Proxy({}, { get: () => { throw new Error("supervisor must not be used"); } }),
    scenarios: () => Promise.resolve([]), log: () => {}, audio, transcript,
  });
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); return api(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function wire(baseUrl: string): void {
  const real = new LauncherClient({ baseUrl, token: TOKEN });
  const auth = consoleAuth([ADMIN]);
  const session = async (id: string) => ({ sessionId: id, scenarioId: "friday-escalation", status: "stopped", owner: ADMIN.id });
  launcher = new Proxy(real, {
    get: (t, k, r) => (k === "session" ? session : Object.hasOwn(auth.launcher, k) ? (auth.launcher as Record<PropertyKey, unknown>)[k] : (Reflect.get(t, k, r) as unknown)),
  });
  timers = manualTimers();
  deps = fakeDeps({ auth, setTimer: timers.setTimer });
  deps.launcher = launcher as unknown as Deps["launcher"];
}

/** An ended session with alice (two clips, seq 1 and 3) and bob (one clip, seq 2), and a running one with one transcribed clip. */
beforeEach(async () => {
  setEnvelopeClock(() => new Date(T0));
  vi.spyOn(console, "error").mockImplementation(() => {});
  seen = [];
  h.record({ identity: A, sessionId: ENDED, ended: true, segments: [
    { role: ALICE, segment: "a-one", seed: 1, seq: 1 }, { role: ALICE, segment: "a-two", seed: 3, seq: 3 }, { role: BOB, segment: "b-one", seed: 2, seq: 2 },
  ] });
  writeLog(ENDED, [utt(ENDED, 1, ALICE, "Alice opens the call"), utt(ENDED, 2, BOB, "Bob answers calmly"), utt(ENDED, 3, ALICE, "Alice closes it out")]);
  h.record({ identity: harness.B, sessionId: RUNNING, segments: [{ role: ALICE, segment: "r-one", seed: 4, seq: 1 }] });
  writeLog(RUNNING, [utt(RUNNING, 1, ALICE, "Still talking")]);
  wire(await startControl((id) => (id === ENDED ? "ended" : id === RUNNING ? "not_ended" : "unknown")));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  vi.restoreAllMocks();
});

const cookie = accountCookie(ADMIN);
const base = (id: string) => `${ORIGIN}/api/v1/console/sessions/${id}/audio`;
const list = (id = ENDED, c = cookie) => handleConsoleAudioList(new Request(base(id), { headers: { Cookie: c } }), deps);
const play = (role: string, segment: string, id = ENDED, c = cookie) =>
  handleConsoleAudioPlay(new Request(`${base(id)}/play?role=${role}&segment=${segment}`, { headers: { Cookie: c } }), deps);
const del = (scope: unknown, id = ENDED, c = cookie) =>
  handleConsoleAudioDelete(new Request(`${base(id)}/delete`, {
    method: "POST", headers: { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", Cookie: c },
    body: JSON.stringify({ scope, reason: "facilitator" }),
  }), deps);
const json = async (r: Response) => (await r.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };
const audioSeen = () => seen.filter((s) => s.includes("/audio") || s.includes("/transcript"));
type ClipOut = { role: string; segment: string; audio: string; text?: string };

describe("audio handlers against the real control", () => {
  it("lists the ended session's clips with the right text and no identity", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    const clips = body.data.clips as ClipOut[];
    expect(clips.map((c) => [c.role, c.segment, c.audio, c.text])).toEqual([
      [ALICE, "a-one", "available", "Alice opens the call"], [BOB, "b-one", "available", "Bob answers calmly"], [ALICE, "a-two", "available", "Alice closes it out"],
    ]);
    expect(clips).toHaveLength(3);
    const raw = JSON.stringify(body);
    for (const leak of [A, "participantId", "identity", "p-a-one", "seq"]) expect(raw).not.toContain(leak);
  });

  it("plays the WAV and writes exactly one audio.played line per play", async () => {
    expect(h.played(A)).toHaveLength(0);
    const res = await play(ALICE, "a-one");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(h.wavOnDisk(A, ALICE, "a-one"))).toBe(true);
    expect(h.played(A)).toHaveLength(1);
    expect((await play(BOB, "b-one")).status).toBe(200);
    expect(h.played(A)).toHaveLength(2);
    // Listing is not a play.
    expect((await list()).status).toBe(200);
    expect(h.played(A)).toHaveLength(2);
  });

  it("deletes one role, then the list shows its clips deleted with the transcript text unchanged, and a play of one is 410", async () => {
    const before = (await json(await list())).data.clips as ClipOut[];
    const res = await del({ kind: "role", role: ALICE });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.data).toMatchObject({ state: "done", pending: [] });
    expect(out.data.deleted).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain(A);
    expect(h.deletedLines(A).length).toBeGreaterThan(0);

    const after = (await json(await list())).data.clips as ClipOut[];
    expect(after).toHaveLength(3);
    for (const c of after) {
      const was = before.find((b) => b.segment === c.segment)!;
      expect(c.text).toBe(was.text);
      expect(c.audio).toBe(c.role === ALICE ? "deleted" : "available");
    }
    const again = await play(ALICE, "a-one");
    expect(again.status).toBe(410);
    expect((await json(again)).error?.code).toBe("audio_deleted");
    expect((await json(await play(ALICE, "a-two"))).error?.code).toBe("audio_deleted");
    expect((await play(BOB, "b-one")).status).toBe(200);
  });

  it("a running session is 409 from the list and from the transcript call", async () => {
    const res = await list(RUNNING);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({ code: "session_live", message: AUDIO_REFUSALS.session_live });
    await expect(launcher.transcript(RUNNING)).rejects.toMatchObject({ reason: "session_live" });
    await expect(launcher.transcript(RUNNING)).rejects.toBeInstanceOf(LauncherError);
    // The ended session's transcript on the same control answers.
    expect(await launcher.transcript(ENDED)).toMatchObject({ kind: "ok" });
  });

  it("a legacy cookie gets 403 account_required and control sees no /audio or /transcript request", async () => {
    const legacy = legacyCookie("Ann");
    for (const res of [await list(ENDED, legacy), await play(ALICE, "a-one", ENDED, legacy), await del({ kind: "session" }, ENDED, legacy)]) {
      expect(res.status).toBe(403);
      expect((await json(res)).error?.code).toBe("account_required");
    }
    expect(audioSeen()).toEqual([]);
    expect(h.played(A)).toHaveLength(0);
  });
});
