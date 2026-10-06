import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider, sanitizeSnippet } from "../openai-compatible.js";
import { ModelProviderError } from "../errors.js";
import { withRetry } from "../retry.js";
import { modelProviderContract } from "../contract.js";
import type { ChatRequest } from "../types.js";
import { delta, reasoningDelta, startFakeServer, type FakeServer } from "./fake-openai-server.js";

const KEY = "sk-TEST-NEVER-LOG-12345";
const REQ: ChatRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 64 };
// Top-level await: the contract suite below builds its provider while tests are collected.
const srv: FakeServer = await startFakeServer();
afterAll(async () => { await srv.close(); });
afterEach(() => { srv.mode = { kind: "stream" }; srv.queue.length = 0; srv.requests.length = 0; });

const make = (over: Partial<ConstructorParameters<typeof OpenAICompatibleModelProvider>[0]> = {}) =>
  new OpenAICompatibleModelProvider({ name: "local", baseUrl: srv.url, model: "m1", ...over });
async function collect(p: OpenAICompatibleModelProvider, req = REQ, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const c of p.stream(req, signal)) out.push(c);
  return out;
}
async function failure(p: OpenAICompatibleModelProvider, req = REQ, signal?: AbortSignal): Promise<Error> {
  try { await collect(p, req, signal); } catch (e) { return e as Error; }
  throw new Error("expected the stream to fail");
}

// The shared contract, including the abort contract, against the in-process server.
modelProviderContract(() => make(), {
  make: () => { srv.queue = [{ kind: "error", status: 503, body: "busy\u0007" }]; return make(); }, kind: "overloaded", transient: true,
});

describe("request shape", () => {
  it("POSTs {base}/chat/completions with the documented headers and body", async () => {
    await collect(make({ apiKey: KEY, baseUrl: `${srv.url}/` }), { ...REQ, cacheSystem: true });
    const r = srv.requests[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/chat/completions");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers.accept).toBe("text/event-stream");
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(r.body)).toEqual({ model: "m1", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], max_tokens: 64, stream: true });
    expect(r.url).not.toContain(KEY);
  });
  it("sends `temperature` only when the request sets it (0 included)", async () => {
    await collect(make(), { ...REQ, temperature: 0.7 });
    await collect(make(), { ...REQ, temperature: 0 });
    await collect(make(), REQ);
    expect(JSON.parse(srv.requests[0]!.body).temperature).toBe(0.7);
    expect(JSON.parse(srv.requests[1]!.body).temperature).toBe(0);
    expect("temperature" in JSON.parse(srv.requests[2]!.body)).toBe(false);
  });
  it("sends no Authorization header when no key is set", async () => {
    await collect(make());
    expect(srv.requests[0]!.headers.authorization).toBeUndefined();
    await collect(make({ apiKey: "   " }));
    expect(srv.requests[1]!.headers.authorization).toBeUndefined();
  });
  it("omits the system message when the system prompt is empty", async () => {
    await collect(make(), { ...REQ, system: "" });
    expect(JSON.parse(srv.requests[0]!.body).messages).toEqual([{ role: "user", content: "hi" }]);
  });
  it("lets req.model override the constructor model", async () => {
    await collect(make(), { ...REQ, model: "other" });
    expect(JSON.parse(srv.requests[0]!.body).model).toBe("other");
  });
  it("exposes its name but never the key", () => {
    const p = make({ apiKey: KEY });
    expect(p.name).toBe("local");
    expect(JSON.stringify(p) + Object.getOwnPropertyNames(p).join(",") + String(Object.values(p))).not.toContain(KEY);
    expect(make({ name: "openrouter" }).name).toBe("openrouter");
  });
});

describe("construction validation", () => {
  const bad = (baseUrl: string, name: "local" | "openrouter" = "local") => () => new OpenAICompatibleModelProvider({ name, baseUrl, model: "m", apiKey: KEY });
  it("rejects userinfo without echoing it", () => {
    let msg = "";
    try { bad("http://alice:hunter2@localhost:11434/v1")(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/LOCAL_BASE_URL.*credentials/);
    expect(msg).not.toMatch(/alice|hunter2/);
  });
  it("rejects empty, invalid, wrong-protocol, query and fragment URLs naming the variable", () => {
    expect(bad("")).toThrow(/LOCAL_BASE_URL is empty/);
    expect(bad("not a url")).toThrow(/LOCAL_BASE_URL is not a valid/);
    expect(bad("ftp://host/v1")).toThrow(/LOCAL_BASE_URL must use https: or http:/);
    expect(bad("http://host/v1?api_key=abc")).toThrow(/query string/);
    expect(bad("http://host/v1#x")).toThrow(/query string or fragment/);
  });
  it("local allows http on any host; openrouter requires https except loopback", () => {
    expect(() => bad("http://192.168.1.5:11434/v1")()).not.toThrow();
    expect(() => bad("https://gpu.example/v1")()).not.toThrow();
    expect(bad("http://openrouter.example/api/v1", "openrouter")).toThrow(/OPENROUTER_BASE_URL must use https/);
    expect(() => bad("https://openrouter.ai/api/v1", "openrouter")()).not.toThrow();
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(() => bad(`http://${h}:9/v1`, "openrouter")()).not.toThrow();
  });
  it("normalizes trailing slashes", async () => {
    await collect(make({ baseUrl: `${srv.url}///` }));
    expect(srv.requests[0]!.url).toBe("/v1/chat/completions");
  });
  it("rejects a blank model and a key that is not a plain header token, without echoing the key", () => {
    expect(() => make({ model: " " })).toThrow(/model id is required/);
    let msg = "";
    try { make({ apiKey: "sk bad\nkey" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/LOCAL_API_KEY/);
    expect(msg).not.toContain("sk bad");
  });
});

describe("stream parsing", () => {
  const raw = (chunks: (string | Buffer)[]) => { srv.mode = { kind: "raw", chunks }; };
  it("ends at [DONE] and ignores anything after it", async () => {
    raw([delta("a"), delta("b"), "data: [DONE]\n\n", delta("never")]);
    expect(await collect(make())).toEqual(["a", "b"]);
  });
  it("treats a stream that ends without [DONE] as the end", async () => {
    raw([delta("a"), delta("b")]);
    expect(await collect(make())).toEqual(["a", "b"]);
  });
  it("skips comment/keepalive lines, blank lines, other fields and events without content", async () => {
    raw([": OPENROUTER PROCESSING\n\n", "\n\n", "event: ping\nid: 7\nretry: 5\n", delta(undefined), delta(null), delta(""), 'data: {"choices":[]}\n\n', 'data: {"id":"x"}\n\n', delta("hi"), ": keepalive\n\n", "data: [DONE]\n\n"]);
    expect(await collect(make())).toEqual(["hi"]);
  });
  it("accepts data: with and without a space, CRLF and bare CR line endings", async () => {
    raw(['data:{"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"c"}}]}\r\r', "data: [DONE]\r\n\r\n"]);
    expect(await collect(make())).toEqual(["a", "b", "c"]);
  });
  it("handles chunks split inside a data: line, inside JSON and inside a multi-byte character", async () => {
    const bytes = Buffer.from(`: hello\n\n${delta("héllo 😀 wörld")}${delta("!")}data: [DONE]\n\n`, "utf8");
    // one byte per chunk: splits "data:", the JSON, and every multi-byte character (the emoji is 4 bytes)
    raw(Array.from(bytes, (b) => Buffer.from([b])));
    expect((await collect(make())).join("")).toBe("héllo 😀 wörld!");
  });
  it("processes an unterminated final data line", async () => {
    raw(['data: {"choices":[{"delta":{"content":"tail"}}]}']);
    expect(await collect(make())).toEqual(["tail"]);
  });
  it("throws a sanitized error for an in-band error event", async () => {
    raw([delta("a"), `data: ${JSON.stringify({ error: { message: `bad\u001b[31m thing ${KEY}\nsecond line`, code: 500 } })}\n\n`]);
    const e = await failure(make({ apiKey: KEY }));
    expect(e.message).toContain("bad");
    // eslint-disable-next-line no-control-regex
    expect(e.message).not.toMatch(/[\u0000-\u001f]/);
    expect(e.message).not.toContain(KEY);
  });
  it("throws without echoing content for a malformed event", async () => {
    raw(["data: {not json " + KEY + "\n\n"]);
    const e = await failure(make({ apiKey: KEY }));
    expect(e.message).toMatch(/malformed/);
    expect(e.message).not.toContain(KEY);
  });
  it("does not support delta.content arrays or multi-line data: events (OpenAI-style servers only)", async () => {
    raw(['data: {"choices":[{"delta":{"content":[{"type":"text","text":"x"}]}}]}\n\n', delta("ok")]);
    expect(await collect(make())).toEqual(["ok"]);
  });
  it("scans a long line trickled in tiny chunks in linear time and still errors at the cap", async () => {
    const bytes = Buffer.from("data: " + "x".repeat(1024 * 1024 + 10));
    let at = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (at >= bytes.length) return c.close(); c.enqueue(bytes.subarray(at, at + 16)); at += 16; } });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
      const started = Date.now();
      expect((await failure(make())).message).toMatch(/oversized/);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally { vi.unstubAllGlobals(); }
  }, 30_000);
  it("rejects an endless line without a terminator", async () => {
    raw(["data: " + "x".repeat(600 * 1024), "y".repeat(600 * 1024)]);
    expect((await failure(make())).message).toMatch(/oversized/);
  });
});

describe("response handling", () => {
  it("falls back to a single JSON object when the server ignores stream:true", async () => {
    srv.mode = { kind: "json", content: "whole answer" };
    expect(await collect(make())).toEqual(["whole answer"]);
  });
  it("accepts a JSON content type with a charset and tolerates a missing message", async () => {
    srv.mode = { kind: "json", content: "x", contentType: "application/json; charset=utf-8" };
    expect(await collect(make())).toEqual(["x"]);
    srv.mode = { kind: "error", status: 200, body: '{"choices":[]}' };
    expect(await collect(make())).toEqual([]);
  });
  it("reports an error object or malformed JSON in the fallback body", async () => {
    srv.mode = { kind: "error", status: 200, body: JSON.stringify({ error: { message: "model not loaded" } }) };
    expect((await failure(make())).message).toMatch(/model not loaded/);
    srv.mode = { kind: "error", status: 200, body: "{nope" };
    expect((await failure(make())).message).toMatch(/malformed JSON/);
  });
  it("caps the JSON fallback body at 1 MiB", async () => {
    srv.mode = { kind: "error", status: 200, body: JSON.stringify({ choices: [{ message: { content: "x".repeat(1024 * 1024 + 10) } }] }) };
    expect((await failure(make())).message).toMatch(/exceeds/);
  });
  it("rejects a response that is neither event-stream nor JSON", async () => {
    srv.mode = { kind: "raw", chunks: ["<html>proxy login</html>"], contentType: "text/html" };
    const e = await failure(make());
    expect(e.message).toMatch(/expected text\/event-stream/);
    expect(e.message).not.toContain("proxy login");
  });
  it("non-2xx: status plus a truncated, control-free snippet, never the key", async () => {
    srv.mode = { kind: "error", status: 401, body: `Incorrect API key ${KEY}\u0007\u001b[2J\n` + "z".repeat(5000), contentType: "text/plain" };
    const e = await failure(make({ apiKey: KEY }));
    expect(e.message).toMatch(/HTTP 401/);
    expect(e.message).toContain("Incorrect API key [redacted]");
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toMatch(/Bearer/i);
    // eslint-disable-next-line no-control-regex
    expect(e.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(e.message.length).toBeLessThan(400);
  });
  it("non-2xx with an empty body still reports the status", async () => {
    srv.mode = { kind: "error", status: 503, body: "" };
    expect((await failure(make())).message).toMatch(/HTTP 503$/);
  });
  it("refuses redirects instead of forwarding credentials", async () => {
    const other = await startFakeServer();
    try {
      srv.mode = { kind: "redirect", location: `${other.url}/chat/completions` };
      const e = await failure(make({ apiKey: KEY }));
      expect(e.message).toMatch(/request failed/);
      expect(e.message).not.toContain(KEY);
      expect(other.requests).toHaveLength(0);
    } finally { await other.close(); }
  });
  it("reports connection failures without the key", async () => {
    const dead = await startFakeServer();
    const url = dead.url;
    await dead.close();
    const e = await failure(make({ baseUrl: url, apiKey: KEY }));
    expect(e.message).toMatch(/request failed/);
    expect(e.message).not.toContain(KEY);
  });
});

describe("abort", () => {
  it("cancels the reader and closes the socket promptly when the consumer aborts mid-stream", async () => {
    srv.mode = { kind: "hang" };
    const ac = new AbortController();
    const seen: string[] = [];
    const started = Date.now();
    for await (const c of make().stream(REQ, ac.signal)) { seen.push(c); ac.abort(); }
    expect(seen).toEqual(["first"]);
    await srv.waitForClose();
    expect(Date.now() - started).toBeLessThan(1_500);
  });
  it("closes the socket when the consumer simply stops iterating", async () => {
    srv.mode = { kind: "hang" };
    for await (const _ of make().stream(REQ)) { void _; break; }
    await srv.waitForClose();
  });
  it("rejects with the abort error when the signal fires while waiting for chunks", async () => {
    srv.mode = { kind: "hang" };
    const ac = new AbortController();
    const it = make().stream(REQ, ac.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe("first");
    const pending = it.next();
    ac.abort();
    await expect(pending).rejects.toBeTruthy();
    await srv.waitForClose();
  });
  it("does not start a request when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(collect(make(), REQ, ac.signal)).rejects.toBeTruthy();
    expect(srv.requests).toHaveLength(0);
  });
});

describe("sanitizeSnippet", () => {
  it("strips control characters, collapses whitespace and truncates", () => {
    expect(sanitizeSnippet("a\u0000b\n\n c\u2028d")).toBe("a b c d");
    expect(sanitizeSnippet("x".repeat(500))).toHaveLength(303);
  });
});

describe("error classification", () => {
  const raw = (chunks: (string | Buffer)[]) => { srv.mode = { kind: "raw", chunks }; };
  const typed = async (p = make({ apiKey: KEY })): Promise<ModelProviderError> => {
    const e = await failure(p);
    expect(e).toBeInstanceOf(ModelProviderError);
    return e as ModelProviderError;
  };
  const err = (status: number, extra: { headers?: Record<string, string>; body?: string } = {}) => {
    srv.mode = { kind: "error", status, body: extra.body ?? "", headers: extra.headers };
  };
  const expectClean = (e: Error) => {
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toMatch(/https?:\/\/|127\.0\.0\.1|\?|Bearer/);
    // eslint-disable-next-line no-control-regex
    expect(e.message).not.toMatch(/[\u0000-\u001f\u007f]/);
  };

  it.each([
    [429, "rate_limited", true], [503, "overloaded", true], [529, "overloaded", true], [500, "server_error", true], [502, "server_error", true],
    [504, "server_error", true], [408, "timeout", true], [401, "auth", false], [403, "auth", false], [404, "not_found", false],
    [400, "bad_request", false], [422, "bad_request", false], [418, "unknown", false],
  ] as const)("HTTP %i -> %s (transient %s) with the existing message text", async (status, kind, transient) => {
    err(status, { body: `nope ${KEY}` });
    const e = await typed();
    expect(e).toMatchObject({ kind, transient, status });
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.message).toMatch(new RegExp(`^local request failed with HTTP ${status}: nope \\[redacted\\]$`));
    expectClean(e);
  });
  it("429 with Retry-After seconds", async () => {
    err(429, { headers: { "Retry-After": "2" }, body: "slow down" });
    expect(await typed()).toMatchObject({ kind: "rate_limited", transient: true, status: 429, retryAfterMs: 2000 });
  });
  it("503 with Retry-After as an HTTP date (relative to the clock)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-01T12:00:00Z") });
    try {
      err(503, { headers: { "Retry-After": "Thu, 01 Oct 2026 12:00:07 GMT" } });
      expect(await typed()).toMatchObject({ kind: "overloaded", transient: true, retryAfterMs: 7000 });
    } finally { vi.useRealTimers(); }
  });
  it("caps an absurd Retry-After and ignores a garbage one", async () => {
    err(429, { headers: { "Retry-After": "86400" } });
    expect((await typed()).retryAfterMs).toBe(10_000);
    err(429, { headers: { "Retry-After": "later" } });
    expect((await typed()).retryAfterMs).toBeUndefined();
  });
  it("HTTP 429 for an exhausted quota or billing limit is permanent (retrying cannot help)", async () => {
    for (const body of [JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }), "billing_hard_limit_reached"]) {
      err(429, { headers: { "Retry-After": "2" }, body });
      const e = await typed();
      expect(e).toMatchObject({ kind: "rate_limited", transient: false, status: 429 });
      expect(e.retryAfterMs).toBeUndefined();
    }
  });
  it("an in-band insufficient_quota error is permanent", async () => {
    raw([`data: ${JSON.stringify({ error: { code: 429, type: "insufficient_quota", message: "Rate limit" } })}\n\n`]);
    expect(await typed()).toMatchObject({ kind: "rate_limited", transient: false });
  });
  it("does not retry-hint a permanent error", async () => {
    err(401, { headers: { "Retry-After": "5" } });
    expect(await typed()).toMatchObject({ kind: "auth", transient: false });
  });

  it("in-band error event with a 429 or 503 code is transient", async () => {
    for (const [code, kind] of [[429, "rate_limited"], [503, "overloaded"]] as const) {
      raw([`data: ${JSON.stringify({ error: { code, message: `try later ${KEY}` } })}\n\n`]);
      const e = await typed();
      expect(e).toMatchObject({ kind, transient: true, status: code });
      expect(e.message).toMatch(/^local reported an error: try later \[redacted\]$/);
    }
  });
  it("in-band text-only overloaded error (no code) is transient, also in the JSON fallback body", async () => {
    raw([`data: ${JSON.stringify({ error: { message: "Upstream error from Nvidia: Service temporarily overloaded" } })}\n\n`]);
    expect(await typed()).toMatchObject({ kind: "overloaded", transient: true });
    srv.mode = { kind: "error", status: 200, body: JSON.stringify({ error: "rate limit exceeded" }) };
    expect(await typed()).toMatchObject({ kind: "rate_limited", transient: true });
  });
  it("other in-band errors are permanent 'unknown' (or by their code)", async () => {
    srv.mode = { kind: "error", status: 200, body: JSON.stringify({ error: { message: "model not loaded" } }) };
    expect(await typed()).toMatchObject({ kind: "unknown", transient: false });
    raw([`data: ${JSON.stringify({ error: { code: 400, message: "bad" } })}\n\n`]);
    expect(await typed()).toMatchObject({ kind: "bad_request", transient: false, status: 400 });
  });
  it("an in-band error after content was streamed is still classified (the wrapper decides about retrying)", async () => {
    raw([delta("a"), `data: ${JSON.stringify({ error: { code: 503, message: "x" } })}\n\n`]);
    const seen: string[] = [];
    let thrown: unknown;
    try { for await (const c of make().stream(REQ)) seen.push(c); } catch (e) { thrown = e; }
    expect(seen).toEqual(["a"]);
    expect(thrown).toMatchObject({ kind: "overloaded", transient: true });
  });

  it("a connection reset is a transient network error without URL or key", async () => {
    srv.mode = { kind: "reset" };
    const e = await typed();
    expect(e).toMatchObject({ kind: "network", transient: true });
    expect(e.message).toMatch(/^local request failed: /);
    expectClean(e);
  });
  it("a refused connection is a transient network error", async () => {
    const dead = await startFakeServer();
    const url = dead.url;
    await dead.close();
    expect(await typed(make({ baseUrl: url, apiKey: KEY }))).toMatchObject({ kind: "network", transient: true });
  });
  it("a refused redirect is a permanent network error", async () => {
    srv.mode = { kind: "redirect", location: "http://127.0.0.1:1/x" };
    expect(await typed()).toMatchObject({ kind: "network", transient: false });
  });
  it("a stream cut mid-body (socket reset after the first chunk) is a transient network error", async () => {
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(delta("a"))); },
      pull() { throw Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
      const seen: string[] = [];
      let thrown: unknown;
      try { for await (const c of make().stream(REQ)) seen.push(c); } catch (e) { thrown = e; }
      expect(seen).toEqual(["a"]);
      expect(thrown).toMatchObject({ name: "ModelProviderError", kind: "network", transient: true });
    } finally { vi.unstubAllGlobals(); }
  });
  it("an aborted request is NOT classified: the abort error passes through untouched", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await failure(make(), REQ, ac.signal).catch((x) => x);
    expect(e).not.toBeInstanceOf(ModelProviderError);
    srv.mode = { kind: "hang" };
    const ac2 = new AbortController();
    const it = make().stream(REQ, ac2.signal)[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    ac2.abort();
    await expect(pending).rejects.not.toBeInstanceOf(ModelProviderError);
    await srv.waitForClose();
  });
  it("a server that answers the second request normally proves each call is independent", async () => {
    srv.queue = [{ kind: "error", status: 503, body: "busy" }];
    await typed();
    expect((await collect(make())).join("")).toBe("OK");
  });
});

describe("reasoning models (US-0026 / AC-0085)", () => {
  const SECRET = "SECRET-THINKING-do-not-show";
  const raw = (chunks: (string | Buffer)[], contentType?: string) => { srv.mode = { kind: "raw", chunks, contentType }; };
  const jsonBody = (message: Record<string, unknown>, finish = "length") => JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }] });

  it.each(["reasoning_content", "reasoning"] as const)("streamed %s with no answer is a transient reasoning_budget error", async (field) => {
    raw([reasoningDelta(`${SECRET} one `, field), reasoningDelta("two", field, "length"), "data: [DONE]\n\n"]);
    const e = await failure(make());
    expect(e).toBeInstanceOf(ModelProviderError);
    const m = e as ModelProviderError;
    expect([m.kind, m.transient]).toEqual(["reasoning_budget", true]);
    expect(m.message).toMatch(/token budget/);
    expect(m.message).toMatch(/NPC_MAX_TOKENS/);
    expect(m.message).toMatch(/GM_MAX_TOKENS/);
    expect(m.message).toMatch(/NPC_FIRST_TOKEN_TIMEOUT_MS/);
    expect(m.message).not.toContain("SECRET");
  });

  it("detects it when the stream ends without [DONE] and with an unterminated final line", async () => {
    raw([reasoningDelta("thinking"), `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "more" }, finish_reason: "length" }] })}`]);
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
  });

  it("mixed: thinking first, then the answer, yields only the answer", async () => {
    raw([reasoningDelta(SECRET), reasoningDelta(SECRET), delta("Hello"), delta(" there"), "data: [DONE]\n\n"]);
    const out = await collect(make());
    expect(out).toEqual(["Hello", " there"]);
    expect(out.join("")).not.toContain("SECRET");
  });

  it("mixed in one delta (content and reasoning together) yields the content", async () => {
    raw([`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: SECRET, content: "Hi" } }] })}\n\n`, "data: [DONE]\n\n"]);
    expect(await collect(make())).toEqual(["Hi"]);
  });

  it("a stream with neither reasoning nor content stays a plain empty reply (no error)", async () => {
    raw([delta(undefined), "data: [DONE]\n\n"]);
    expect(await collect(make())).toEqual([]);
  });

  it("empty-string reasoning does not count as reasoning", async () => {
    raw([reasoningDelta(""), "data: [DONE]\n\n"]);
    expect(await collect(make())).toEqual([]);
  });

  it("does not accumulate the reasoning text (large reasoning streams in bounded memory and is still detected)", async () => {
    const big = "x".repeat(200_000);
    raw([...Array.from({ length: 20 }, () => reasoningDelta(big)), "data: [DONE]\n\n"]);
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
  });

  it.each(["reasoning_content", "reasoning"] as const)("JSON body with %s and empty content is a reasoning_budget error", async (field) => {
    raw([jsonBody({ content: "", [field]: `${SECRET} chain` })], "application/json");
    const e = (await failure(make())) as ModelProviderError;
    expect([e.kind, e.transient]).toEqual(["reasoning_budget", true]);
    expect(e.message).not.toContain("SECRET");
  });

  it("JSON body with null content and reasoning is the same error", async () => {
    raw([jsonBody({ content: null, reasoning_content: "thinking" })], "application/json");
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
  });

  it("JSON body with reasoning AND an answer yields only the answer", async () => {
    raw([jsonBody({ content: "Answer", reasoning_content: SECRET }, "stop")], "application/json");
    expect(await collect(make())).toEqual(["Answer"]);
  });

  it("JSON body with empty content, no reasoning and a normal stop stays a plain empty reply", async () => {
    raw([jsonBody({ content: "" }, "stop")], "application/json");
    expect(await collect(make())).toEqual([]);
  });

  it("empty content with finish_reason length and no reasoning field is a reasoning_budget error (JSON and stream)", async () => {
    raw([jsonBody({ content: "" }, "length")], "application/json");
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
    raw([delta(undefined), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`, "data: [DONE]\n\n"]);
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
  });

  it("reasoning only after a normal stop is a non-transient unknown error without budget advice (JSON and stream)", async () => {
    raw([jsonBody({ content: "", reasoning_content: SECRET }, "stop")], "application/json");
    for (let i = 0; i < 2; i++) {
      const e = (await failure(make())) as ModelProviderError;
      expect([e.kind, e.transient]).toEqual(["unknown", false]);
      expect(e.message).toMatch(/the model returned only reasoning and no answer/);
      expect(e.message).not.toMatch(/MAX_TOKENS|SECRET/);
      raw([reasoningDelta(SECRET, "reasoning_content", "stop"), "data: [DONE]\n\n"]);
    }
  });

  it("uses the last non-null finish_reason (a null one after length does not hide it)", async () => {
    raw([reasoningDelta("t", "reasoning_content", "length"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}\n\n`, "data: [DONE]\n\n"]);
    expect(((await failure(make())) as ModelProviderError).kind).toBe("reasoning_budget");
  });

  it("the retry layer retries it (transient) and a later answer wins", async () => {
    srv.queue = [{ kind: "raw", chunks: [reasoningDelta("thinking"), "data: [DONE]\n\n"] }];
    const p = withRetry(make(), { maxRetries: 1, sleep: async () => {} });
    const out: string[] = [];
    for await (const c of p.stream(REQ)) out.push(c);
    expect(out.join("")).toBe("OK");
    expect(srv.requests).toHaveLength(2);
  });
});
