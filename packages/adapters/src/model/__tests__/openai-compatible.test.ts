import { afterAll, afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleModelProvider, sanitizeSnippet } from "../openai-compatible.js";
import { modelProviderContract } from "../contract.js";
import type { ChatRequest } from "../types.js";
import { delta, startFakeServer, type FakeServer } from "./fake-openai-server.js";

const KEY = "sk-TEST-NEVER-LOG-12345";
const REQ: ChatRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 64 };
// Top-level await: the contract suite below builds its provider while tests are collected.
const srv: FakeServer = await startFakeServer();
afterAll(async () => { await srv.close(); });
afterEach(() => { srv.mode = { kind: "stream" }; srv.requests.length = 0; });

const make = (over: Partial<ConstructorParameters<typeof OpenAICompatibleModelProvider>[0]> = {}) =>
  new OpenAICompatibleModelProvider({ name: "local", baseUrl: srv.url, model: "m1", ...over });
async function collect(p: OpenAICompatibleModelProvider, req = REQ, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const c of p.stream(req, signal)) out.push(c);
  return out;
}
async function failure(p: OpenAICompatibleModelProvider): Promise<Error> {
  try { await collect(p); } catch (e) { return e as Error; }
  throw new Error("expected the stream to fail");
}

// The shared contract, including the abort contract, against the in-process server.
modelProviderContract(() => make());

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
  it("sends no Authorization header when no key is set", async () => {
    await collect(make());
    expect(srv.requests[0]!.headers.authorization).toBeUndefined();
    await collect(make({ apiKey: "   " }));
    expect(srv.requests[1]!.headers.authorization).toBeUndefined();
  });
  it("lets req.model override the constructor model", async () => {
    await collect(make(), { ...REQ, model: "other" });
    expect(JSON.parse(srv.requests[0]!.body).model).toBe("other");
  });
  it("exposes its name and the endpoint host but never the key", () => {
    const p = make({ apiKey: KEY });
    expect(p.name).toBe("local");
    expect(p.endpointHost).toBe(srv.host);
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
