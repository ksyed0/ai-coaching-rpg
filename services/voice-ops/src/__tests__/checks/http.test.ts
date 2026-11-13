import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { livekitCheck } from "../../checks/livekit.js";
import { adminToken, livekitKeysCheck } from "../../checks/livekit-keys.js";
import { tlsRouteCheck } from "../../checks/tls.js";
import { whisperCheck } from "../../checks/whisper.js";

// US-0072 (EPIC-0003 voice A1c, Task 8): the checks that ask a server something, against real loopback stand-in servers (never a real
// whisper-server or LiveKit). None of them may print the STT URL, a header value, a key, the secret, the token or a room name.

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });
async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}
const PATH = "/0123456789abcdef0123456789abcdef";

describe("whisperCheck", () => {
  const whisper = (health: { status: number; body: string }, cors: string | null) => serve((req, res) => {
    if (req.method === "GET" && req.url === `${PATH}/health`) { res.writeHead(health.status, { "content-type": "application/json" }); res.end(health.body); return; }
    if (req.method === "OPTIONS" && req.url === `${PATH}/inference`) { res.writeHead(204, cors ? { "access-control-allow-origin": cors, "access-control-allow-headers": "content-type, authorization" } : {}); res.end(); return; }
    res.writeHead(404); res.end();
  });
  it("ok, loading, down", async () => {
    const ok = await whisper({ status: 200, body: '{"status":"ok"}' }, null);
    expect(await whisperCheck({ sttUrl: new URL(`http://127.0.0.1:${ok}${PATH}`) })).toEqual([
      { name: "whisper", level: "ok", line: "whisper-server is healthy on 127.0.0.1" },
      { name: "whisper-cors", level: "ok", line: "whisper-server does not answer cross-origin requests" },
    ]);
    const loading = await whisper({ status: 503, body: '{"status":"loading model"}' }, null);
    expect((await whisperCheck({ sttUrl: new URL(`http://127.0.0.1:${loading}${PATH}`) }))[0]!.level).toBe("warn");
    const down = await serve((_q, r) => { r.destroy(); });
    expect(await whisperCheck({ sttUrl: new URL(`http://127.0.0.1:${down}${PATH}`) })).toEqual([{ name: "whisper", level: "fail", line: "whisper-server does not answer on 127.0.0.1: run pnpm voice:up" }]);
  });
  it("reports a cross-origin answer without printing the URL or a header value", async () => {
    for (const [cors, said] of [["*", "any origin (*)"], ["https://voice-check.invalid", "a specific origin"]] as const) {
      const port = await whisper({ status: 200, body: '{"status":"ok"}' }, cors);
      const r = await whisperCheck({ sttUrl: new URL(`http://127.0.0.1:${port}${PATH}`) });
      expect(r[1]).toEqual({ name: "whisper-cors", level: "warn", line: `whisper-server answers cross-origin requests for ${said}: keep the STT_URL path secret (docs/VOICE_RUNBOOK.md)` });
      for (const x of r) { expect(x.line).not.toContain(PATH.slice(1)); expect(x.line).not.toContain(String(port)); expect(x.line).not.toContain("voice-check.invalid"); expect(x.line).not.toContain("authorization"); }
    }
  });
});

describe("livekitCheck and tlsRouteCheck", () => {
  it("answers / does not", async () => {
    const port = await serve((_q, r) => { r.writeHead(200); r.end("OK"); });
    expect(await livekitCheck({ host: new URL(`http://127.0.0.1:${port}`) })).toEqual({ name: "livekit", level: "ok", line: `LiveKit answers on 127.0.0.1:${port}` });
    expect((await livekitCheck({ host: new URL("http://127.0.0.1:1") })).level).toBe("fail");
  });
  it("tlsRouteCheck: a trusted handshake and any HTTP answer is ok", async () => {
    expect(await tlsRouteCheck({ hostname: "voice.pilot.example", port: 7443, connect: async () => ({ authorized: true, status: 404 }) })).toEqual({ name: "tls-route", level: "ok", line: "the TLS route https://voice.pilot.example:7443/rtc answers with a trusted certificate" });
    expect((await tlsRouteCheck({ hostname: "voice.pilot.example", port: 7443, connect: async () => ({ authorized: false, status: null }) })).level).toBe("fail");
  });
});

describe("livekitKeysCheck", () => {
  const key = "APIplaceholderkey00000001";
  const secret = "placeholder-secret-0123456789abcdef-0123456789";
  const now = 1_800_000_000_000;
  const b64 = (s: string): unknown => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

  it("the admin token is HS256 with only roomList and a 60 s expiry (signed through WebCrypto HMAC, PR #135)", async () => {
    const t = await adminToken(key, secret, now);
    const [h, p, sig] = t.split(".") as [string, string, string];
    expect(b64(h)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(b64(p)).toEqual({ iss: key, nbf: now / 1000, exp: now / 1000 + 60, video: { roomList: true } });
    expect(sig).toBe(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"));
  });

  it("200 is ok, 401 fails with the voice:down sentence, no answer skips; it posts ListRooms once with the bearer token", async () => {
    const seen: { url?: string; method?: string; auth?: string; body: string }[] = [];
    let status = 200;
    const port = await serve((req, res) => {
      let body = ""; req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => { seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body }); res.writeHead(status, { "content-type": "application/json" }); res.end('{"rooms":[{"name":"seat-room-secret-name"}]}'); });
    });
    const host = new URL(`http://127.0.0.1:${port}`);
    const ok = await livekitKeysCheck({ host, key, secret, now });
    expect(ok).toEqual({ name: "livekit-keys", level: "ok", line: "LiveKit accepts control's keys" });
    expect(seen).toEqual([{ url: "/twirp/livekit.RoomService/ListRooms", method: "POST", auth: `Bearer ${await adminToken(key, secret, now)}`, body: "{}" }]);
    status = 401;
    expect(await livekitKeysCheck({ host, key, secret, now })).toEqual({ name: "livekit-keys", level: "fail", line: "LiveKit does not accept control's keys: run pnpm voice:down and pnpm voice:up" });
    status = 500;
    expect((await livekitKeysCheck({ host, key, secret, now })).level).toBe("warn");
    expect((await livekitKeysCheck({ host: new URL("http://127.0.0.1:1"), key, secret, now })).level).toBe("skip");
    expect((await livekitKeysCheck({ host, key: undefined, secret, now })).level).toBe("skip");
  });

  it("prints neither the token, the key, the secret nor a room name", async () => {
    const port = await serve((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200); res.end('{"rooms":[{"name":"seat-room-secret-name"}]}'); }); });
    const lines: string[] = [];
    for (const st of [200]) { void st; lines.push((await livekitKeysCheck({ host: new URL(`http://127.0.0.1:${port}`), key, secret, now })).line); }
    lines.push((await livekitKeysCheck({ host: new URL("http://127.0.0.1:1"), key, secret, now })).line);
    const token = await adminToken(key, secret, now);
    for (const l of lines) for (const v of [token, key, secret, "seat-room-secret-name", token.split(".")[2]!]) expect(l).not.toContain(v);
  });

  it("refuses a host that is not loopback without a request", async () => {
    expect((await livekitKeysCheck({ host: new URL("http://192.168.1.20:7880"), key, secret, now })).level).toBe("skip");
  });
});
