import { describe, expect, it, vi } from "vitest";
import { LauncherClient, LauncherError, type LauncherReason } from "../launcher-client";

const BASE = "http://127.0.0.1:47123";
const TOKEN = "service-token-0123456789abcdef0123456789abcdef";
const SID = "s-0123456789abcdef";
const BY = "ada-lovelace-console";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; init: RequestInit | undefined };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
      init,
    };
    calls.push(c);
    return handler(c);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const client = (f: typeof fetch) => new LauncherClient({ baseUrl: BASE, token: TOKEN, fetch: f });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = (data: unknown) => json({ success: true, data, error: null });
const err = (status: number, code: string, data: unknown = null) =>
  json({ success: false, data, error: { code, message: "control text /secret/path" } }, status);
async function reasonOf(p: Promise<unknown>): Promise<LauncherReason> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LauncherError);
    return (e as LauncherError).reason;
  }
  throw new Error("expected a LauncherError");
}

const SEG = {
  identity: "somebody-real",
  role: "tech_lead",
  segment: "seg-1",
  participantId: "p-1",
  startMs: 10,
  endMs: 20,
  status: "transcribed",
  seq: 4,
  audio: "available",
  extra: "x",
};

describe("audioList", () => {
  it("maps fields one by one, drops the identity and sends X-Acr-By", async () => {
    const f = fakeFetch(() => ok({ identities: ["somebody-real"], recordingStopped: true, segments: [SEG, { ...SEG, seq: undefined, audio: "deleted" }] }));
    const r = await client(f.fetch).audioList(SID, BY);
    expect(r).toEqual({
      recordingStopped: true,
      segments: [
        { role: "tech_lead", segment: "seg-1", participantId: "p-1", startMs: 10, endMs: 20, status: "transcribed", seq: 4, audio: "available" },
        { role: "tech_lead", segment: "seg-1", participantId: "p-1", startMs: 10, endMs: 20, status: "transcribed", audio: "deleted" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("somebody-real");
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/audio`, method: "GET" });
    expect(f.calls[0]!.headers["x-acr-by"]).toBe(BY);
    expect(f.calls[0]!.headers["x-service-token"]).toBe(TOKEN);
  });
  it("404 gives null", async () => {
    expect(await client(fakeFetch(() => err(404, "not_found")).fetch).audioList(SID, BY)).toBeNull();
  });
  it("a malformed answer is failed; a bad session id never reaches the network", async () => {
    expect(await reasonOf(client(fakeFetch(() => ok({ segments: "no" })).fetch).audioList(SID, BY))).toBe("failed");
    const f = fakeFetch(() => ok({}));
    expect(await reasonOf(client(f.fetch).audioList("../x", BY))).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });
});

describe("transcript", () => {
  const LINES = [{ seq: 1, ts: 5, roleId: "tech_lead", text: "hi", extra: 1 }];
  it("ok maps lines", async () => {
    const f = fakeFetch(() => ok({ lines: LINES, truncated: false }));
    expect(await client(f.fetch).transcript(SID)).toEqual({ kind: "ok", lines: [{ seq: 1, ts: 5, roleId: "tech_lead", text: "hi" }] });
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/transcript`, method: "GET" });
  });
  it("413 is too_large", async () => {
    expect(await client(fakeFetch(() => err(413, "transcript_too_large")).fetch).transcript(SID)).toEqual({ kind: "too_large" });
  });
  it("parses a body near 1,000,000 characters", async () => {
    const text = "a".repeat(1_000_000 - 100);
    const r = await client(fakeFetch(() => ok({ lines: [{ seq: 1, ts: 1, roleId: "r", text: text.replace(/a/g, "\\") }], truncated: false })).fetch).transcript(SID);
    expect(r.kind).toBe("ok");
  });
  it("409 session_live and 503 busy throw their reasons", async () => {
    expect(await reasonOf(client(fakeFetch(() => err(409, "session_live")).fetch).transcript(SID))).toBe("session_live");
    expect(await reasonOf(client(fakeFetch(() => err(503, "busy")).fetch).transcript(SID))).toBe("busy");
    expect(await reasonOf(client(fakeFetch(() => err(404, "not_found")).fetch).transcript(SID))).toBe("not_found");
  });
});

describe("audioPlay", () => {
  const wav = (n: number, status = 200) => new Response(new Uint8Array(n).fill(7), { status, headers: { "Content-Type": "audio/wav" } });
  it("returns the bytes, sends no body, the token, X-Acr-By and Accept audio/wav", async () => {
    const f = fakeFetch(() => wav(100));
    const b = await client(f.fetch).audioPlay(SID, "tech_lead", "seg-1", BY);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.length).toBe(100);
    const c = f.calls[0]!;
    expect(c.url).toBe(`${BASE}/sessions/${SID}/audio/tech_lead/seg-1`);
    expect(c.method).toBe("GET");
    expect(c.body).toBeUndefined();
    expect(c.headers["x-acr-by"]).toBe(BY);
    expect(c.headers["x-service-token"]).toBe(TOKEN);
    expect(c.headers.accept).toBe("audio/wav");
    expect(c.init?.redirect).toBe("error");
  });
  it("maps 410, 503 audit_unavailable, 503 store_unsafe, 503 busy, 404", async () => {
    const p = (r: Response) => client(fakeFetch(() => r).fetch).audioPlay(SID, "r", "s", BY);
    expect(await reasonOf(p(err(410, "audio_deleted")))).toBe("audio_deleted");
    expect(await reasonOf(p(err(503, "audit_unavailable")))).toBe("audit_unavailable");
    expect(await reasonOf(p(err(503, "store_unsafe")))).toBe("store_unsafe");
    expect(await reasonOf(p(err(503, "busy")))).toBe("busy");
    expect(await reasonOf(p(err(404, "not_found")))).toBe("not_found");
  });
  it("over the size cap throws failed; an empty body is failed", async () => {
    const p = (r: Response) => client(fakeFetch(() => r).fetch).audioPlay(SID, "r", "s", BY);
    expect(await reasonOf(p(wav(512 * 1024 + 4096 + 1)))).toBe("failed");
    expect((await p(wav(512 * 1024))).length).toBe(512 * 1024);
    expect(await reasonOf(p(wav(0)))).toBe("failed");
  });
  it("a bad role or segment never reaches fetch", async () => {
    const f = fakeFetch(() => wav(1));
    expect(await reasonOf(client(f.fetch).audioPlay(SID, "../x", "s", BY))).toBe("not_found");
    expect(await reasonOf(client(f.fetch).audioPlay(SID, "r", "a/b", BY))).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });
});

describe("audioDelete", () => {
  const full = (pending: unknown[] = []) => ({
    deleted: 3,
    gone: [],
    identities: [{ identity: "somebody-real", deleted: 3, state: "done" }, { identity: "other-real", deleted: 0, state: "pending" }],
    pending,
  });
  const del = (r: Response, scope: Parameters<LauncherClient["audioDelete"]>[1] = { kind: "session" }) => {
    const f = fakeFetch(() => r);
    return { f, p: client(f.fetch).audioDelete(SID, scope, "facilitator", BY) };
  };
  it("200 gives done with counts and no identity; sends scope, reason, by and the header", async () => {
    const { f, p } = del(ok(full()), { kind: "role", role: "tech_lead" });
    const r = await p;
    expect(r).toEqual({ state: "done", deleted: 3, done: 2, pending: [] });
    expect(JSON.stringify(r)).not.toContain("real");
    const c = f.calls[0]!;
    expect(c).toMatchObject({ url: `${BASE}/sessions/${SID}/audio`, method: "DELETE" });
    expect(JSON.parse(String(c.body))).toEqual({ scope: { kind: "role", role: "tech_lead" }, reason: "facilitator", by: BY });
    expect(c.headers["x-acr-by"]).toBe(BY);
  });
  it("503 with a partial body gives pending with reasons, no identity", async () => {
    const { p } = del(err(503, "store_unsafe", full([{ identity: "somebody-real", reason: "store_unsafe" }, { identity: "o", reason: "busy" }])));
    const r = await p;
    expect(r).toEqual({ state: "pending", deleted: 3, done: 2, pending: [{ reason: "store_unsafe" }, { reason: "busy" }] });
    expect(JSON.stringify(r)).not.toContain("real");
  });
  it("503 with null data throws busy; 404 throws not_found", async () => {
    expect(await reasonOf(del(err(503, "busy")).p)).toBe("busy");
    expect(await reasonOf(del(err(404, "not_found")).p)).toBe("not_found");
  });
  it("409 gives live with the partial result", async () => {
    expect(await del(err(409, "session_live", full())).p).toEqual({ state: "live", deleted: 3, done: 2, pending: [] });
  });
  it("a malformed 503 body is failed, not a success", async () => {
    expect(await reasonOf(del(err(503, "store_unsafe", { deleted: "x" })).p)).toBe("failed");
  });
  it("a bad role never reaches fetch", async () => {
    const { f, p } = del(ok(full()), { kind: "role", role: "../x" });
    expect(await reasonOf(p)).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });
  it("uses the 15 s report timeout, not the 5 s default", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await client(fakeFetch(() => ok(full())).fetch).audioDelete(SID, { kind: "session" }, "facilitator", BY);
      expect(spy).toHaveBeenCalledWith(15_000);
    } finally {
      spy.mockRestore();
    }
  });
});
