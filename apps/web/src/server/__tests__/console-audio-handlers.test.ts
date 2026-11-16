import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_REFUSALS } from "../../lib/messages";
import { accountSlug } from "../console-report-handlers";
import { handleConsoleAudioDelete, handleConsoleAudioList, handleConsoleAudioPlay } from "../console-audio-handlers";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherClient, type AccountInfo } from "../launcher-client";
import {
  ADMIN, FACILITATOR, FIXTURE_ORIGIN as ORIGIN, FIXTURE_T0 as T0, accountCookie, consoleAuth, fakeDeps, legacyCookie,
} from "../test-support/console-fixtures";
import { JoinThrottle } from "../throttle";
import { manualTimers } from "./fakes";

// A2b-2 Task 4: the audio list, play and delete routes. The fake control is a LauncherClient over a fake fetch; the console's own auth
// and ownership lookups are answered by the fixtures, so `sent` holds only what these routes ask of control (filtered to /audio and /transcript).

const SID = "s-1111111111111111";
const SID_OTHER = "s-2222222222222222";
const OTHER_FAC: AccountInfo = { ...FACILITATOR, id: "acc-fac-0099", login: "sam@client.example", name: "Sam Ortiz", epoch: 5 };
const BY = `${accountSlug(ADMIN.name, ADMIN.id)}-console`;
const FAC_BY = `${accountSlug(FACILITATOR.name, FACILITATOR.id)}-console`;

type Sent = { method: string; path: string; body: unknown; headers: Record<string, string> };
let sent: Sent[];
let answer: (s: Sent) => Response | Promise<Response>;
let deps: Deps;
let timers: ReturnType<typeof manualTimers>;

const env = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const good = (data: unknown = {}) => env(200, { success: true, data, error: null });
const refused = (status: number, code: string, data: unknown = null) =>
  env(status, { success: false, data, error: { code, message: "TEXT FROM CONTROL /srv/secret" } }, { "Retry-After": "9", "X-Control-Secret": "nope" });

const SEG = (o: Record<string, unknown> = {}) => ({
  identity: "folder-real-name", role: "alice", segment: "seg-1", participantId: "p-secret-1", startMs: 1000, endMs: 2000, status: "transcribed", seq: 7, audio: "available", ...o,
});
const listing = (segments: unknown[] = [SEG()]) => ({ identities: ["folder-real-name"], recordingStopped: true, segments });
const lines = (l: unknown[] = [{ seq: 7, ts: 5, roleId: "alice", text: "Hello there" }]) => ({ lines: l });
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

/** What these routes asked of control: nothing else (the console's auth and ownership lookups never land here). */
const audioCalls = (id = SID) => sent.filter((s) => s.path.startsWith(`/sessions/${id}/audio`) || s.path.startsWith(`/sessions/${id}/transcript`));

function build(over: { read?: number; write?: number } = {}) {
  sent = [];
  answer = () => good();
  timers = manualTimers();
  const real = new LauncherClient({
    baseUrl: "http://127.0.0.1:47123", token: "launcher-token-" + "t".repeat(20),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const s: Sent = {
        method: init?.method ?? "GET", path: u.pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      sent.push(s);
      return answer(s);
    }) as typeof fetch,
  });
  const auth = consoleAuth([ADMIN, FACILITATOR, OTHER_FAC]);
  const session = vi.fn(async (id: string) => ({ sessionId: id, scenarioId: "friday-escalation", status: "stopped", ...(id === SID ? { owner: FACILITATOR.id } : { owner: OTHER_FAC.id }) }));
  const launcher = new Proxy(real, {
    get: (t, k, r) => (k === "session" ? session : Object.hasOwn(auth.launcher, k) ? (auth.launcher as Record<PropertyKey, unknown>)[k] : (Reflect.get(t, k, r) as unknown)),
  });
  deps = fakeDeps({
    auth, setTimer: timers.setTimer,
    consoleAudioReadThrottle: new JoinThrottle({ max: over.read ?? 120, windowMs: 60_000, blockMs: 60_000, now: () => T0 }),
    consoleAudioWriteThrottle: new JoinThrottle({ max: over.write ?? 10, windowMs: 60_000, blockMs: 60_000, now: () => T0 }),
  });
  deps.launcher = launcher as unknown as LauncherClient;
}

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  vi.spyOn(console, "error").mockImplementation(() => {});
  build();
});
afterEach(() => { vi.restoreAllMocks(); });

const ADMIN_COOKIE = accountCookie(ADMIN);
const base = (id = SID) => `${ORIGIN}/api/v1/console/sessions/${id}/audio`;
const get = (path = "", o: { cookie?: string | null; id?: string } = {}) => {
  const h: Record<string, string> = {};
  const c = o.cookie === undefined ? ADMIN_COOKIE : o.cookie;
  if (c !== null) h.Cookie = c;
  return new Request(`${base(o.id)}${path}`, { headers: h });
};
const play = (role = "alice", segment = "seg-1", o: Parameters<typeof get>[1] = {}) => get(`/play?role=${role}&segment=${segment}`, o);
const post = (body: unknown, o: { cookie?: string; id?: string; raw?: string } = {}) =>
  new Request(`${base(o.id)}/delete`, {
    method: "POST",
    headers: { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", Cookie: o.cookie ?? ADMIN_COOKIE },
    body: o.raw ?? JSON.stringify(body),
  });
const DEL = { scope: { kind: "session" }, reason: "facilitator" };
const json = async (r: Response) => (await r.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };

const controlList = (s: Sent) => s.path === `/sessions/${SID}/audio` && s.method === "GET";
const controlTranscript = (s: Sent) => s.path === `/sessions/${SID}/transcript`;

describe("legacy sign-in and ownership (Review Focus 2)", () => {
  it("a legacy cookie gets 403 account_required from all three routes and no audio call reaches control", async () => {
    const cookie = legacyCookie("Ann");
    for (const res of [
      await handleConsoleAudioList(get("", { cookie }), deps),
      await handleConsoleAudioPlay(play("alice", "seg-1", { cookie }), deps),
      await handleConsoleAudioDelete(post(DEL, { cookie }), deps),
    ]) {
      expect(res.status).toBe(403);
      expect((await json(res)).error).toEqual({ code: "account_required", message: AUDIO_REFUSALS.account_required });
    }
    expect(audioCalls()).toEqual([]);
    expect(deps.consoleAudioReadThrottle.size).toBe(0);
    expect(deps.consoleAudioWriteThrottle.size).toBe(0);
  });

  it("a facilitator that does not own the session gets the neutral 404 and no audio call reaches control", async () => {
    const cookie = accountCookie(FACILITATOR);
    for (const res of [
      await handleConsoleAudioList(get("", { cookie, id: SID_OTHER }), deps),
      await handleConsoleAudioPlay(play("alice", "seg-1", { cookie, id: SID_OTHER }), deps),
      await handleConsoleAudioDelete(post(DEL, { cookie, id: SID_OTHER }), deps),
    ]) {
      expect(res.status).toBe(404);
      expect((await json(res)).error?.code).toBe("not_found");
    }
    expect(audioCalls(SID_OTHER)).toEqual([]);
  });

  it("no cookie is 401 and a cross-site delete is 403, both before any control call", async () => {
    expect((await handleConsoleAudioList(get("", { cookie: null }), deps)).status).toBe(401);
    const bad = new Request(`${base()}/delete`, { method: "POST", headers: { Origin: "https://evil.example", "X-Requested-With": "scenecoach", "Content-Type": "application/json", Cookie: ADMIN_COOKIE }, body: JSON.stringify(DEL) });
    expect((await handleConsoleAudioDelete(bad, deps)).status).toBe(403);
    expect(audioCalls()).toEqual([]);
  });
});

describe("list", () => {
  it("joins the list and the transcript, sends the server-built by, and never shows identity, participantId or seq", async () => {
    answer = (s) => (controlList(s) ? good(listing()) : controlTranscript(s) ? good(lines()) : good());
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await json(res);
    expect(body.data).toEqual({
      recordingStopped: true,
      clips: [{ role: "alice", segment: "seg-1", startMs: 1000, endMs: 2000, status: "transcribed", audio: "available", text: "Hello there" }],
    });
    const raw = JSON.stringify(body);
    for (const leak of ["folder-real-name", "p-secret-1", "seq", "participantId", "identity"]) expect(raw).not.toContain(leak);
    expect(audioCalls().map((s) => s.path)).toEqual([`/sessions/${SID}/audio`, `/sessions/${SID}/transcript`]);
    expect(audioCalls()[0]!.headers["x-acr-by"]).toBe(BY);
  });

  it("the facilitator's by is its own account slug, never one from the query", async () => {
    answer = (s) => (controlList(s) ? good(listing([SEG({ status: "empty", seq: undefined })])) : good());
    await handleConsoleAudioList(get("?by=evil-console", { cookie: accountCookie(FACILITATOR) }), deps);
    expect(audioCalls()[0]!.headers["x-acr-by"]).toBe(FAC_BY);
  });

  it("does not ask for the transcript when no clip is transcribed with a seq", async () => {
    answer = (s) => (controlList(s) ? good(listing([SEG({ status: "empty", seq: undefined }), SEG({ segment: "s2", status: "stt_failed" }), SEG({ segment: "s3", seq: undefined })])) : good());
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(200);
    expect((await json(res)).data.clips).toHaveLength(3);
    expect(audioCalls().some(controlTranscript)).toBe(false);
  });

  it("a transcript session_live makes the whole list 409 session_live", async () => {
    answer = (s) => (controlList(s) ? good(listing()) : refused(409, "session_live"));
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toEqual({ code: "session_live", message: AUDIO_REFUSALS.session_live });
    expect(body.data).toBeNull();
  });

  it("a list session_live is 409 too", async () => {
    answer = () => refused(409, "session_live");
    expect((await handleConsoleAudioList(get(), deps)).status).toBe(409);
  });

  it("a transcript failure gives textUnavailable and the clips still come back, without text", async () => {
    answer = (s) => (controlList(s) ? good(listing()) : refused(503, "unavailable"));
    const body = await json(await handleConsoleAudioList(get(), deps));
    expect(body.data.textUnavailable).toBe(true);
    expect(body.data.tooLongForText).toBeUndefined();
    expect(body.data.clips).toEqual([{ role: "alice", segment: "seg-1", startMs: 1000, endMs: 2000, status: "transcribed", audio: "available" }]);
  });

  it("a transcript too_large gives tooLongForText and the clips still come back", async () => {
    answer = (s) => (controlList(s) ? good(listing()) : refused(413, "transcript_too_large"));
    const body = await json(await handleConsoleAudioList(get(), deps));
    expect(body.data.tooLongForText).toBe(true);
    expect(body.data.textUnavailable).toBeUndefined();
    expect(body.data.clips).toHaveLength(1);
  });

  it("a control 404 on the list gives no clips", async () => {
    answer = () => refused(404, "not_found");
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ recordingStopped: false, clips: [] });
    expect(audioCalls().some(controlTranscript)).toBe(false);
  });

  it("other control failures show our own sentence, never control's text or headers", async () => {
    answer = () => refused(503, "busy");
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-control-secret")).toBeNull();
    const text = JSON.stringify(await json(res));
    expect(text).not.toContain("TEXT FROM CONTROL");
    expect(text).not.toContain("/srv/secret");
  });
});

describe("play", () => {
  it("returns the bytes with the four headers and sends the server-built by", async () => {
    answer = () => new Response(WAV, { status: 200, headers: { "Content-Type": "audio/wav", "Set-Cookie": "a=b", "X-Control-Secret": "nope" } });
    const res = await handleConsoleAudioPlay(play(), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("accept-ranges")).toBe("none");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-control-secret")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WAV);
    expect(audioCalls()).toHaveLength(1);
    expect(audioCalls()[0]!.path).toBe(`/sessions/${SID}/audio/alice/seg-1`);
    expect(audioCalls()[0]!.headers["x-acr-by"]).toBe(BY);
  });

  it("a bad or missing role or segment is 404 before control", async () => {
    for (const q of ["?role=../x&segment=seg-1", "?role=alice&segment=a%2Fb", "?role=alice", "?segment=seg-1", "", "?role=alice&role=bob&segment=s", `?role=${"a".repeat(80)}&segment=s`]) {
      const res = await handleConsoleAudioPlay(get(`/play${q}`), deps);
      expect([q, res.status]).toEqual([q, 404]);
    }
    expect(audioCalls()).toEqual([]);
  });

  it("maps 410, 503 audit_unavailable, 503 store_unsafe and busy", async () => {
    answer = () => refused(410, "audio_deleted");
    let res = await handleConsoleAudioPlay(play(), deps);
    expect(res.status).toBe(410);
    expect((await json(res)).error).toEqual({ code: "audio_deleted", message: AUDIO_REFUSALS.audio_deleted });
    answer = () => refused(503, "audit_unavailable");
    res = await handleConsoleAudioPlay(play(), deps);
    expect([res.status, (await json(res)).error?.code]).toEqual([503, "audit_unavailable"]);
    answer = () => refused(503, "store_unsafe");
    res = await handleConsoleAudioPlay(play(), deps);
    expect([res.status, (await json(res)).error?.code]).toEqual([503, "store_unsafe"]);
    answer = () => refused(503, "busy");
    res = await handleConsoleAudioPlay(play(), deps);
    expect([res.status, (await json(res)).error?.code]).toEqual([503, "busy"]);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("control 404 is the neutral 404", async () => {
    answer = () => refused(404, "not_found");
    const res = await handleConsoleAudioPlay(play(), deps);
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("not_found");
  });

  it("control session_live is 409", async () => {
    answer = () => refused(409, "session_live");
    expect((await handleConsoleAudioPlay(play(), deps)).status).toBe(409);
  });
});

describe("delete", () => {
  const DONE = { deleted: 3, identities: ["folder-real-name", "other-real"], pending: [] };

  it("sends the server-built by in the header and the body, ignores a body by, and carries no identity back", async () => {
    answer = () => good(DONE);
    const res = await handleConsoleAudioDelete(post({ ...DEL, scope: { kind: "role", role: "alice" }, reason: "participant_request" }), deps);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toEqual({ state: "done", deleted: 3, done: 2, pending: [] });
    expect(JSON.stringify(body)).not.toContain("folder-real-name");
    const c = audioCalls();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ method: "DELETE", path: `/sessions/${SID}/audio` });
    expect(c[0]!.headers["x-acr-by"]).toBe(BY);
    expect(c[0]!.body).toEqual({ scope: { kind: "role", role: "alice" }, reason: "participant_request", by: BY });
  });

  it("a by in the browser's delete body is ignored (the request is still accepted)", async () => {
    answer = () => good(DONE);
    const res = await handleConsoleAudioDelete(post({ ...DEL, by: "evil-console" }), deps);
    expect(res.status).toBe(200);
    expect((audioCalls()[0]!.body as { by: string }).by).toBe(BY);
    expect(audioCalls()[0]!.headers["x-acr-by"]).toBe(BY);
  });

  it("a facilitator's own by, not the admin's", async () => {
    answer = () => good(DONE);
    await handleConsoleAudioDelete(post(DEL, { cookie: accountCookie(FACILITATOR) }), deps);
    expect((audioCalls()[0]!.body as { by: string }).by).toBe(FAC_BY);
  });

  it("pending is 503 with the partial result and no success state, and carries no identity (Review Focus 3)", async () => {
    answer = () => refused(503, "audit_unavailable", { deleted: 1, identities: ["folder-real-name"], pending: [{ reason: "busy" }, { reason: "store_unsafe" }] });
    const res = await handleConsoleAudioDelete(post(DEL), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).not.toBeNull();
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("store_unsafe");
    expect(body.data).toEqual({ state: "pending", deleted: 1, done: 1, pending: [{ reason: "busy" }, { reason: "store_unsafe" }] });
    expect(JSON.stringify(body)).not.toContain("folder-real-name");
    expect(JSON.stringify(body)).not.toContain("TEXT FROM CONTROL");
  });

  it("pending with only busy reasons is a 503 busy", async () => {
    answer = () => refused(503, "busy", { deleted: 0, identities: [], pending: [{ reason: "busy" }] });
    const body = await json(await handleConsoleAudioDelete(post(DEL), deps));
    expect(body.error?.code).toBe("busy");
    expect(body.success).toBe(false);
  });

  it("control 503 busy with no data is web 503 busy; control 404 is web 404", async () => {
    answer = () => refused(503, "busy");
    let res = await handleConsoleAudioDelete(post(DEL), deps);
    expect([res.status, (await json(res)).error?.code]).toEqual([503, "busy"]);
    answer = () => refused(404, "not_found");
    res = await handleConsoleAudioDelete(post(DEL), deps);
    expect(res.status).toBe(404);
  });

  it("a live session is 409 session_live", async () => {
    answer = () => refused(409, "session_live", { deleted: 0, identities: [], pending: [] });
    const res = await handleConsoleAudioDelete(post(DEL), deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("session_live");
  });

  it("rejects unknown keys, a role scope without a role, a bad scope, a bad reason, a bad role, an oversized or non-JSON body, before control", async () => {
    build({ write: 100 }); // many bad bodies in a row: the budget is not what is tested here
    const bad: unknown[] = [
      { ...DEL, extra: 1 },
      { scope: { kind: "role" }, reason: "facilitator" },
      { scope: { kind: "role", role: "../x" }, reason: "facilitator" },
      { scope: { kind: "session", role: "alice" }, reason: "facilitator" },
      { scope: { kind: "all" }, reason: "facilitator" },
      { scope: "session", reason: "facilitator" },
      { scope: { kind: "session" }, reason: "because" },
      { scope: { kind: "session" } },
      { reason: "facilitator" },
      [],
      "x",
    ];
    for (const b of bad) {
      const res = await handleConsoleAudioDelete(post(b), deps);
      expect([JSON.stringify(b), res.status]).toEqual([JSON.stringify(b), 400]);
    }
    expect((await handleConsoleAudioDelete(post(null, { raw: "{nope" }), deps)).status).toBe(400);
    expect((await handleConsoleAudioDelete(post(null, { raw: JSON.stringify({ ...DEL, pad: "x".repeat(2000) }) }), deps)).status).toBe(413);
    expect(audioCalls()).toEqual([]);
  });
});

describe("throttles", () => {
  it("reads (list and play share one budget) are throttled per account with Retry-After, and a new cookie does not reset it", async () => {
    build({ read: 3 });
    answer = (s) => (controlList(s) ? good(listing([SEG({ status: "empty", seq: undefined })])) : new Response(WAV, { status: 200 }));
    expect((await handleConsoleAudioList(get(), deps)).status).toBe(200);
    expect((await handleConsoleAudioPlay(play(), deps)).status).toBe(200);
    expect((await handleConsoleAudioList(get(), deps)).status).toBe(200);
    const before = audioCalls().length;
    const fresh = accountCookie(ADMIN, { expiresAt: T0 + 7_200_000 });
    expect(fresh).not.toBe(ADMIN_COOKIE);
    const res = await handleConsoleAudioPlay(play("alice", "seg-1", { cookie: fresh }), deps);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await handleConsoleAudioList(get("", { cookie: fresh }), deps)).status).toBe(429);
    expect(audioCalls()).toHaveLength(before);
    // another account has its own budget
    expect((await handleConsoleAudioList(get("", { cookie: accountCookie(FACILITATOR) }), deps)).status).toBe(200);
  });

  it("delete is throttled on its own budget, per account", async () => {
    build({ write: 2 });
    answer = () => good({ deleted: 0, identities: [], pending: [] });
    expect((await handleConsoleAudioDelete(post(DEL), deps)).status).toBe(200);
    expect((await handleConsoleAudioDelete(post(DEL), deps)).status).toBe(200);
    const res = await handleConsoleAudioDelete(post(DEL, { cookie: accountCookie(ADMIN, { expiresAt: T0 + 7_200_000 }) }), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(audioCalls()).toHaveLength(2);
    // reads are untouched by the delete budget
    answer = (s) => (controlList(s) ? good(listing([SEG({ status: "empty", seq: undefined })])) : good());
    expect((await handleConsoleAudioList(get(), deps)).status).toBe(200);
  });
});

describe("transport failures", () => {
  it("a transport throw is our own 503 sentence, never the thrown text", async () => {
    answer = () => { throw new TypeError("secret /srv/path"); };
    // the launcher turns a transport throw into `unavailable`: still our own sentence
    const res = await handleConsoleAudioList(get(), deps);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await json(res))).not.toContain("secret");
  });
});
