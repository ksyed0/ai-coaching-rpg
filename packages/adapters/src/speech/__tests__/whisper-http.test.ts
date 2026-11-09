import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSttUrl, WhisperHttpSpeechToText } from "../whisper-http.js";
import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError } from "../errors.js";
import { decodeWav } from "../wav.js";
import type { SpeechSegment } from "../types.js";
import { json, startFakeWhisper } from "./whisper-server.js";

// US-0070 (Task 12, AC-0402): the local Whisper client, against a real node:http server on 127.0.0.1:0. Loopback only.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
async function serve(handle: Parameters<typeof startFakeWhisper>[0]) { const s = await startFakeWhisper(handle); servers.push(s); return s; }
const client = (port: number, prefix = "") => {
  const p = parseSttUrl(`http://127.0.0.1:${port}${prefix}`);
  if (!p.ok) throw new Error(p.error);
  return new WhisperHttpSpeechToText({ url: p.url });
};
const seg = (samples = 1600): SpeechSegment => ({ id: "s1", pcm: new Int16Array(samples).fill(123), sampleRate: 16000, deadline: Number.MAX_SAFE_INTEGER });
const failure = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (err) { return err; } };

describe("parseSttUrl (US-0070)", () => {
  it("accepts http://127.0.0.1:9000 and http://[::1]:9000/abc", () => {
    const a = parseSttUrl("http://127.0.0.1:9000");
    expect(a.ok && a.url.href).toBe("http://127.0.0.1:9000/");
    const b = parseSttUrl("http://[::1]:9000/abc");
    expect(b.ok && b.url.href).toBe("http://[::1]:9000/abc");
  });

  it("refuses localhost, 0.0.0.0, a LAN address, https, a query, a fragment, user info, no port and a missing value", () => {
    for (const raw of ["http://localhost:9000", "http://0.0.0.0:9000", "http://192.168.1.5:9000", "https://127.0.0.1:9000", "http://127.0.0.1:9000/?k=v", "http://127.0.0.1:9000/#x", "http://u:p@127.0.0.1:9000", "http://127.0.0.1", "not a url", "", "  ", "http://example.com:9000", "file:///etc/passwd"]) {
      const r = parseSttUrl(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) { expect(r.error).toContain("STT_URL"); for (const leak of ["192.168", "example.com", "u:p@", "k=v", "#x", "passwd", "not a url", "localhost:9000", "0.0.0.0"]) expect(r.error).not.toContain(leak); }
    }
    const missing = parseSttUrl(undefined);
    expect(missing.ok).toBe(false);
  });

  // F9d (review fix wave): kept on purpose and pinned. WHATWG URL drops the default port (":80" becomes ""), so an explicit :80 cannot
  // be told from no port at all; whisper-server is never on 80 in this design, and "an explicit port" stays the one simple rule.
  it("refuses an explicit :80 (the URL parser normalises the default port away, so it reads as no port)", () => {
    for (const raw of ["http://127.0.0.1:80", "http://[::1]:80/abc"]) expect(parseSttUrl(raw).ok, raw).toBe(false);
    expect(parseSttUrl("http://127.0.0.1:8080").ok).toBe(true);
  });
});

describe("WhisperHttpSpeechToText (US-0070)", () => {
  it("the request is multipart to <prefix>/inference with file (the WAV), response_format=verbose_json and temperature", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: " hello there " }));
    const t = await client(s.port, "/secret-prefix").transcribe(seg(320));
    expect(t.text).toBe("hello there");
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
    const req = s.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/secret-prefix/inference");
    const form = await new Response(new Uint8Array(req.body), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("temperature")).toBe("0.0");
    const file = form.get("file") as File;
    const wav = decodeWav(new Uint8Array(await file.arrayBuffer()));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.pcm.length).toBe(320);
  });

  it("verbose_json with segments gives noSpeechProb (the max) and avgLogprob (duration-weighted)", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "x", segments: [{ start: 0, end: 1, no_speech_prob: 0.1, avg_logprob: -0.2 }, { start: 1, end: 4, no_speech_prob: 0.4, avg_logprob: -0.6 }] }));
    const t = await client(s.port).transcribe(seg());
    expect(t.noSpeechProb).toBeCloseTo(0.4);
    expect(t.avgLogprob).toBeCloseTo((-0.2 * 1 + -0.6 * 3) / 4);
  });

  it("without usable durations avgLogprob is the plain mean", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "x", segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }] }));
    expect((await client(s.port).transcribe(seg())).avgLogprob).toBeCloseTo(-0.3);
  });

  it("a json answer with only text leaves both undefined", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "just text" }));
    const t = await client(s.port).transcribe(seg());
    expect(t).toEqual({ text: "just text", durationMs: expect.any(Number) });
    expect("noSpeechProb" in t).toBe(false);
  });

  it("NaN or string probabilities are ignored, and a segments value that is not a list too", async () => {
    const s = await serve((r, res) => json(res, 200, s.requests.length === 1
      ? '{"text":"x","segments":[{"no_speech_prob":"0.9","avg_logprob":"bad"},{"no_speech_prob":null},7]}'
      : '{"text":"y","segments":{"no_speech_prob":0.9}}'));
    const t = await client(s.port).transcribe(seg());
    expect(t.noSpeechProb).toBeUndefined();
    expect(t.avgLogprob).toBeUndefined();
    expect((await client(s.port).transcribe(seg())).noSpeechProb).toBeUndefined();
    void s;
  });

  it("a 503 is Unavailable, a 400 is Refused, HTML is Refused, a text that is not a string is Refused, a 300 KiB body is Refused", async () => {
    const answers: [number, string][] = [[503, "{}"], [400, '{"error":"bad"}'], [200, "<html>no</html>"], [200, '{"text":5}'], [200, `{"text":"${"a".repeat(300 * 1024)}"}`], [302, ""]];
    let i = 0;
    const s = await serve((_r, res) => { const [status, body] = answers[i++]!; if (status === 302) { res.writeHead(302, { location: "http://192.168.1.5:9/x" }); res.end(); return; } res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    const c = client(s.port);
    const kinds = [];
    for (let n = 0; n < answers.length; n++) kinds.push((await failure(c.transcribe(seg()))) as Error);
    expect(kinds.map((e) => e.constructor.name)).toEqual(["SpeechUnavailableError", "SpeechRefusedError", "SpeechRefusedError", "SpeechRefusedError", "SpeechRefusedError", "SpeechRefusedError"]);
    expect(s.requests).toHaveLength(answers.length); // the redirect was not followed
    for (const e of kinds) expect(e.message).not.toMatch(/127\.0\.0\.1|192\.168|<html>|inference/);
  });

  it("a server that never answers gives Timeout when the signal aborts (abort by hand, no sleep)", async () => {
    let got!: () => void;
    const arrived = new Promise<void>((r) => { got = r; });
    const s = await serve(() => { got(); /* never answers */ });
    const ac = new AbortController();
    const p = failure(client(s.port).transcribe(seg(), ac.signal));
    await arrived;
    ac.abort();
    expect(await p).toBeInstanceOf(SpeechTimeoutError);
  });

  it("a body that stalls after the headers gives Timeout when the signal aborts", async () => {
    let got!: () => void;
    const arrived = new Promise<void>((r) => { got = r; });
    const s = await serve((_r, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"text":"par'); got(); });
    const ac = new AbortController();
    const p = failure(client(s.port).transcribe(seg(), ac.signal));
    await arrived;
    ac.abort();
    expect(await p).toBeInstanceOf(SpeechTimeoutError);
  });

  it("an aborted signal gives Timeout before any request", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "x" }));
    const ac = new AbortController();
    ac.abort();
    expect(await failure(client(s.port).transcribe(seg(), ac.signal))).toBeInstanceOf(SpeechTimeoutError);
    expect(s.requests).toHaveLength(0);
  });

  it("health is true only on 200 from <prefix>/health, false on 503, and false on a refused connection (a closed port)", async () => {
    let status = 200;
    const s = await serve((r, res) => { res.writeHead(r.url === "/p/health" ? status : 404); res.end("{}"); });
    expect(await client(s.port, "/p").health()).toBe(true);
    status = 503;
    expect(await client(s.port, "/p").health()).toBe(false);
    const closed = await startFakeWhisper(() => {});
    const port = closed.port;
    await closed.close();
    expect(await client(port).health()).toBe(false);
    expect(await failure(client(port).transcribe(seg()))).toBeInstanceOf(SpeechUnavailableError);
  });

  it("warmUp transcribes one second of silence and ignores the text", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "[BLANK_AUDIO]" }));
    await client(s.port).warmUp();
    expect(s.requests).toHaveLength(1);
    const form = await new Response(new Uint8Array(s.requests[0]!.body), { headers: { "content-type": String(s.requests[0]!.headers["content-type"]) } }).formData();
    const wav = decodeWav(new Uint8Array(await (form.get("file") as File).arrayBuffer()));
    expect(wav.pcm.length).toBe(16000);
    expect(wav.pcm.every((x) => x === 0)).toBe(true);
  });

  it("durationMs comes from the injected clock", async () => {
    const s = await serve((_r, res) => json(res, 200, { text: "x" }));
    let t = 1000;
    const p = parseSttUrl(`http://127.0.0.1:${s.port}`);
    if (!p.ok) throw new Error(p.error);
    const c = new WhisperHttpSpeechToText({ url: p.url, now: () => (t += 40) });
    expect((await c.transcribe(seg())).durationMs).toBe(40);
  });

  it("an injected fetch that throws a non-abort error is Unavailable; a refused answer never quotes the body", async () => {
    const p = parseSttUrl("http://127.0.0.1:9");
    if (!p.ok) throw new Error(p.error);
    const c = new WhisperHttpSpeechToText({ url: p.url, fetch: (async () => { throw new TypeError("fetch failed: secret http://x"); }) as typeof fetch });
    const e = (await failure(c.transcribe(seg()))) as Error;
    expect(e).toBeInstanceOf(SpeechUnavailableError);
    expect(e.message).not.toContain("secret");
    expect(await c.health()).toBe(false);
    const r = new WhisperHttpSpeechToText({ url: p.url, fetch: (async () => new Response('{"error":"SECRET body"}', { status: 422 })) as typeof fetch });
    const e2 = (await failure(r.transcribe(seg()))) as SpeechRefusedError;
    expect(e2.status).toBe(422);
    expect(e2.message).not.toContain("SECRET");
  });
});
