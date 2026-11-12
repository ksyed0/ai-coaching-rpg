import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// US-0074 (voice A2b-1a, Task 7): GET /sessions/:id/audio and GET /sessions/:id/audio/:role/:segment, real HTTP against createApi with
// a real temp store. Seam: records every path-taking fs call, so a refusal can prove it touched no file. Passthrough by default.
const hooks = vi.hoisted(() => ({ calls: null as null | string[] }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const rec = (name: string, p: unknown) => { hooks.calls?.push(`${name} ${String(p)}`); };
  const wrap = <K extends keyof typeof actual>(name: K) =>
    ((p: unknown, ...rest: unknown[]) => { rec(name, p); return (actual[name] as (...a: unknown[]) => unknown)(p, ...rest); }) as unknown as (typeof actual)[K];
  return {
    ...actual,
    openSync: wrap("openSync"), readdirSync: wrap("readdirSync"), lstatSync: wrap("lstatSync"), statSync: wrap("statSync"),
    readFileSync: wrap("readFileSync"), mkdirSync: wrap("mkdirSync"), accessSync: wrap("accessSync"),
    existsSync: ((p: string) => { rec("existsSync", p); return actual.existsSync(p); }) as typeof actual.existsSync,
  };
});
const fs = await import("node:fs");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = fs;
const { createApi } = await import("../../api.js");
const { AudioCatalog } = await import("../../voice/audio-catalog.js");
const { AuditLog } = await import("../../voice/audit-log.js");
const { AudioService, parseBy } = await import("../../voice/audio-routes.js");
type ControlConfig = import("../../config.js").ControlConfig;
type AuditEvent = import("../../voice/audit-log.js").AuditEvent;

const TOKEN = "t".repeat(40);
const S = "session-1", OTHER = "session-2";
const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb);
const BY = "kamal-console";

let root: string, audioDir: string;
const servers: http.Server[] = [];
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-audio-routes-"));
  audioDir = path.join(root, "audio");
  mkdirSync(audioDir, { mode: 0o700 });
  hooks.calls = null;
});
afterEach(async () => {
  hooks.calls = null;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  rmSync(root, { recursive: true, force: true });
});

// --- the store, as the speech worker leaves it ---
const SECRET = "the secret words somebody said";
const segLine = (segment: string, startMs: number, extra: Record<string, unknown> = {}) =>
  ({ v: 1, kind: "segment", segment, participantId: `p-${segment}`, startMs, endMs: startMs + 500, status: "transcribed", raw: SECRET, ...extra });
const delLine = (segment: string) => ({ v: 1, kind: "deleted", segment, op: "op-1", ts: 1 });
const jsonl = (lines: unknown[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
const wavBytes = (size: number, seed = 1): Buffer => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + seed) & 0xff));
/** `<audioDir>/<identity>/session.json` (unless `sessionId` is null). */
function mkIdentity(identity: string, sessionId: string | null = S): void {
  const dir = path.join(audioDir, identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (sessionId !== null) writeFileSync(path.join(dir, "session.json"), JSON.stringify({ v: 1, sessionId }), { mode: 0o600 });
}
function mkRole(identity: string, role: string, index: unknown[], wavs: Record<string, Buffer> = {}): void {
  const dir = path.join(audioDir, identity, role);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "index.jsonl"), jsonl(index), { mode: 0o600 });
  for (const [seg, bytes] of Object.entries(wavs)) writeFileSync(path.join(dir, `${seg}.wav`), bytes, { mode: 0o600 });
}
const auditPath = (identity: string) => path.join(audioDir, `${identity}.audio-audit.jsonl`);
const auditLines = (identity: string): Record<string, unknown>[] => {
  const was = hooks.calls; hooks.calls = null; // the test's own reads are not the server's
  try { return existsSync(auditPath(identity)) ? readFileSync(auditPath(identity), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : []; }
  finally { hooks.calls = was; }
};
const playedLines = (identity: string) => auditLines(identity).filter((l) => l.type === "audio.played");

// --- the server ---
/** A supervisor that throws on ANY use: these routes must never ask it (no `supervisor.get`). */
const untouchable = new Proxy({}, { get: () => { throw new Error("the audio routes must not use the supervisor"); } });

type Audit = { append: (identity: string, e: AuditEvent) => Promise<boolean> };
async function boot(o: { audit?: Audit; maxInFlight?: number; audio?: false; catalog?: InstanceType<typeof AudioCatalog> } = {}) {
  const real = new AuditLog({ audioDir, now: () => 1234 });
  const append = vi.fn((identity: string, e: AuditEvent) => (o.audit ?? real).append(identity, e));
  const catalog = o.catalog ?? new AudioCatalog({ audioDir });
  const audio = o.audio === false ? undefined
    : new AudioService({ catalog, audit: { append }, audioDir, ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}) });
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: untouchable as never, scenarios: () => Promise.resolve([]),
    ...(audio ? { audio } : {}),
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  /** A raw GET (so the path is sent exactly as written and repeated headers are possible). */
  const get = (p: string, headers: Record<string, string | string[]> = {}, o2: { token?: string | null; method?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const h: Record<string, string | string[]> = { ...headers };
      const token = o2.token === undefined ? TOKEN : o2.token;
      if (token !== null) h["x-service-token"] = token;
      const req = http.request({ host: "127.0.0.1", port, path: p, method: o2.method ?? "GET", headers: h, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  return { get, append, port };
}
const by = (v: string | string[] = BY) => ({ "x-acr-by": v });
const json = (b: Buffer) => JSON.parse(b.toString("utf8")) as { success: boolean; data: unknown; error: { code: string; message?: string } | null };
function expectJsonEnvelope(r: { headers: http.IncomingHttpHeaders; body: Buffer }): void {
  expect(r.headers["content-type"]).toBe("application/json");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(Number(r.headers["content-length"])).toBe(r.body.length);
}

/** A two-identity session (a restart rotated the log): A holds role alpha, B holds beta with one deleted segment and a stop mark. */
function twoIdentities(): { s1: Buffer; s2: Buffer } {
  const s1 = wavBytes(1000, 1), s2 = wavBytes(800, 2);
  mkIdentity(A); mkIdentity(B);
  mkRole(A, "alpha", [segLine("s1", 1000, { seq: 1 })], { s1 });
  mkRole(B, "beta", [segLine("s2", 500), segLine("s3", 900, { status: "empty" }), delLine("s3")], { s2 });
  writeFileSync(auditPath(B), jsonl([{ v: 1, ts: 2, type: "voice.recording_stopped", reason: "disk_low" }]), { mode: 0o600 });
  return { s1, s2 };
}

describe("sendBytes", () => {
  it("writes the exact status, the headers plus Content-Length, then the bytes once", async () => {
    const { sendBytes } = await import("../../http-util.js");
    const calls: unknown[][] = [];
    const res = { headersSent: false, writeHead: (...a: unknown[]) => { calls.push(["writeHead", ...a]); }, end: (...a: unknown[]) => { calls.push(["end", ...a]); }, destroy: () => { calls.push(["destroy"]); } };
    const bytes = Buffer.from("RIFFxxxx");
    sendBytes(res as never, 200, { "Content-Type": "audio/wav" }, bytes);
    expect(calls).toStrictEqual([["writeHead", 200, { "Content-Type": "audio/wav", "Content-Length": "8" }], ["end", bytes]]);
  });
  it("when headers are already out it writes nothing more and destroys the response (a body is never appended to another)", async () => {
    const { sendBytes } = await import("../../http-util.js");
    const calls: unknown[][] = [];
    const res = { headersSent: true, writeHead: () => { calls.push(["writeHead"]); }, end: () => { calls.push(["end"]); }, destroy: () => { calls.push(["destroy"]); } };
    sendBytes(res as never, 200, {}, Buffer.from("RIFF"));
    expect(calls).toStrictEqual([["destroy"]]);
  });
});

describe("parseBy (the review layer's console name: <name>-console)", () => {
  it("accepts <name>-console where <name> passes isConsoleName (a safe id of at most 56 characters)", () => {
    expect(parseBy("kamal-console")).toBe("kamal-console");
    expect(parseBy(`${"a".repeat(56)}-console`)).toBe(`${"a".repeat(56)}-console`);
    expect(parseBy("Kamal_S-console")).toBe("Kamal_S-console");
  });
  it.each([
    ["missing", undefined], ["empty", ""], ["x", "x"], ["no suffix", "kamal"], ["the suffix alone", "-console"],
    ["a 57-character name", `${"a".repeat(57)}-console`], ["57+ characters without the suffix", "a".repeat(57)],
    ["a control character", "ka\u0001mal-console"], ["DEL", "ka\u007fmal-console"], ["a tab", "ka\tmal-console"],
    ["a comma-joined duplicate", "kamal-console, other-console"], ["a comma", "kamal,-console"], ["a space", "ka mal-console"],
    ["a dot", "ka.mal-console"], ["a slash", "ka/mal-console"], ["the suffix in another case", "kamal-Console"],
    ["a trailing space", "kamal-console "], ["non-ASCII", "kämal-console"],
  ])("refuses %s", (_label, v) => {
    expect(parseBy(v as string | undefined)).toBeNull();
  });
  it("refuses a non-string (an array that a caller passed through)", () => {
    expect(parseBy(["kamal-console"] as unknown as string)).toBeNull();
  });
});

describe("GET /sessions/:id/audio (the listing)", () => {
  it("lists every identity's segments in the exact shape, sorted by identity, never with raw; recordingStopped from any identity", async () => {
    twoIdentities();
    const { get, append } = await boot();
    const r = await get(`/sessions/${S}/audio`, by());
    expect(r.status).toBe(200);
    expectJsonEnvelope(r);
    expect(json(r.body)).toStrictEqual({
      success: true, error: null,
      data: {
        identities: 2,
        recordingStopped: true,
        segments: [
          { identity: A, role: "alpha", segment: "s1", participantId: "p-s1", startMs: 1000, endMs: 1500, status: "transcribed", seq: 1, audio: "available" },
          { identity: B, role: "beta", segment: "s2", participantId: "p-s2", startMs: 500, endMs: 1000, status: "transcribed", audio: "available" },
          { identity: B, role: "beta", segment: "s3", participantId: "p-s3", startMs: 900, endMs: 1400, status: "empty", audio: "deleted" },
        ],
      },
    });
    expect(r.body.toString("utf8")).not.toContain(SECRET);
    expect(r.body.toString("utf8")).not.toContain("raw");
    expect(append).not.toHaveBeenCalled(); // a listing is not a replay
  });

  it("recordingStopped is false when no identity has the stop mark", async () => {
    mkIdentity(A);
    mkRole(A, "alpha", [segLine("s1", 0)], { s1: wavBytes(100) });
    const { get } = await boot();
    expect(json((await get(`/sessions/${S}/audio`, by())).body).data).toMatchObject({ identities: 1, recordingStopped: false });
  });

  it("a session with a marker folder but no segments lists none", async () => {
    mkIdentity(A);
    const { get } = await boot();
    const r = await get(`/sessions/${S}/audio`, by());
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({ identities: 1, recordingStopped: false, segments: [] });
  });

  it("an unknown session, and one whose only folder has no marker, are 404 not_found", async () => {
    mkIdentity(A, OTHER);
    mkIdentity(B, null);
    mkRole(B, "alpha", [segLine("s1", 0)], { s1: wavBytes(100) });
    const { get } = await boot();
    for (const sid of [S, "never-seen"]) {
      const r = await get(`/sessions/${sid}/audio`, by());
      expect(r.status, sid).toBe(404);
      expectJsonEnvelope(r);
      expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "not_found", message: "That session has no audio." } });
    }
  });

  it("a trailing slash is the same route", async () => {
    mkIdentity(A);
    const { get } = await boot();
    expect((await get(`/sessions/${S}/audio/`, by())).status).toBe(200);
  });
});

describe("GET /sessions/:id/audio/:role/:segment (the replay)", () => {
  it("returns the exact WAV bytes with the binary headers and writes one audio.played line", async () => {
    const { s1, s2 } = twoIdentities();
    const { get } = await boot();
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(200);
    expect(r.body.equals(s1)).toBe(true);
    expect(r.headers["content-type"]).toBe("audio/wav");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["accept-ranges"]).toBe("none");
    expect(r.headers["content-length"]).toBe(String(s1.length));
    expect(r.headers["content-range"]).toBeUndefined();
    expect(playedLines(A)).toStrictEqual([{ v: 1, ts: 1234, type: "audio.played", role: "alpha", segment: "s1", by: BY }]);
    // the second identity holds the other segment: the line goes to THAT identity's log
    const r2 = await get(`/sessions/${S}/audio/beta/s2`, by());
    expect(r2.status).toBe(200);
    expect(r2.body.equals(s2)).toBe(true);
    expect(playedLines(B)).toStrictEqual([{ v: 1, ts: 1234, type: "audio.played", role: "beta", segment: "s2", by: BY }]);
    expect(playedLines(A)).toHaveLength(1);
  });

  it("exactly one audio.played line per 200", async () => {
    twoIdentities();
    const { get } = await boot();
    for (let i = 0; i < 3; i++) expect((await get(`/sessions/${S}/audio/alpha/s1`, by())).status).toBe(200);
    expect(playedLines(A)).toHaveLength(3);
    for (const l of playedLines(A)) expect(Object.keys(l).sort()).toEqual(["by", "role", "segment", "ts", "type", "v"]);
  });

  it.each(["bytes=10-20", "bytes=0-0,5-9", "bytes=99999999999999999999-", "bytes=-5", "garbage"])("Range %j is ignored: the full 200 body", async (range) => {
    const { s1 } = twoIdentities();
    const { get } = await boot();
    const r = await get(`/sessions/${S}/audio/alpha/s1`, { ...by(), range });
    expect(r.status).toBe(200);
    expect(r.body.equals(s1)).toBe(true);
    expect(r.headers["content-length"]).toBe(String(s1.length));
    expect(r.headers["accept-ranges"]).toBe("none");
    expect(r.headers["content-range"]).toBeUndefined();
  });

  it("a deleted segment is 410 audio_deleted and writes no audio.played line", async () => {
    twoIdentities();
    const { get } = await boot();
    const r = await get(`/sessions/${S}/audio/beta/s3`, by());
    expect(r.status).toBe(410);
    expectJsonEnvelope(r);
    expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "audio_deleted" } });
    expect(playedLines(B)).toEqual([]);
  });

  it("an unknown segment, an unknown session and a no-marker session are 404", async () => {
    twoIdentities();
    mkIdentity(id(0xc), null);
    mkRole(id(0xc), "alpha", [segLine("s9", 0)], { s9: wavBytes(100) });
    const { get } = await boot();
    for (const p of [`/sessions/${S}/audio/alpha/nope`, `/sessions/${OTHER}/audio/alpha/s1`, `/sessions/${S}/audio/alpha/s9`]) {
      const r = await get(p, by());
      expect(r.status, p).toBe(404);
      expectJsonEnvelope(r);
      expect(json(r.body).error?.code).toBe("not_found");
    }
    expect(playedLines(A)).toEqual([]);
  });

  it("an audit append resolving false is 503 audit_unavailable with NOT ONE audio byte", async () => {
    const { s1 } = twoIdentities();
    const { get, append } = await boot({ audit: { append: async () => false } });
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(503);
    expectJsonEnvelope(r);
    expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "audit_unavailable" } });
    expect(r.headers["content-type"]).not.toBe("audio/wav");
    expect(r.body.includes(s1.subarray(0, 16))).toBe(false);
    expect(r.body.length).toBeLessThan(100);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("a throwing audit is 503 audit_unavailable and frees the in-flight slot", async () => {
    const { s1 } = twoIdentities();
    let fail = true;
    const real = new AuditLog({ audioDir, now: () => 1234 });
    const { get } = await boot({ maxInFlight: 1, audit: { append: (i, e) => { if (fail) throw new Error("boom"); return real.append(i, e); } } });
    for (let i = 0; i < 3; i++) expect((await get(`/sessions/${S}/audio/alpha/s1`, by())).status).toBe(503);
    fail = false;
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(200);
    expect(r.body.equals(s1)).toBe(true);
  });

  it("a catalog that throws is a 500 and frees the in-flight slot", async () => {
    const { s1 } = twoIdentities();
    const catalog = new AudioCatalog({ audioDir });
    const find = vi.spyOn(catalog, "find").mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("boom"));
    const { get } = await boot({ maxInFlight: 1, catalog });
    expect((await get(`/sessions/${S}/audio/alpha/s1`, by())).status).toBe(500);
    expect((await get(`/sessions/${S}/audio/alpha/s1`, by())).status).toBe(500);
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(200);
    expect(r.body.equals(s1)).toBe(true);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("9 concurrent replays held open by a slow audit: the 9th is 503 busy with Retry-After, and the counter recovers", async () => {
    const { s1 } = twoIdentities();
    const real = new AuditLog({ audioDir, now: () => 1234 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    let allHeld!: () => void;
    const eight = new Promise<void>((r) => { allHeld = r; });
    let slow = true;
    const { get } = await boot({
      audit: { append: async (i, e) => { if (slow) { held++; if (held === 8) allHeld(); await gate; } return real.append(i, e); } },
    });
    const first = Array.from({ length: 8 }, () => get(`/sessions/${S}/audio/alpha/s1`, by()));
    await eight;
    const ninth = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(ninth.status).toBe(503);
    expectJsonEnvelope(ninth);
    expect(ninth.headers["retry-after"]).toBe("1");
    expect(json(ninth.body).error?.code).toBe("busy");
    expect(held).toBe(8); // the 9th never reached the audit (nor the file)
    slow = false;
    release();
    for (const r of await Promise.all(first)) { expect(r.status).toBe(200); expect(r.body.equals(s1)).toBe(true); }
    const tenth = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(tenth.status).toBe(200);
    expect(playedLines(A)).toHaveLength(9);
  });
});

describe("refusals before any file call", () => {
  const routes = [`/sessions/${S}/audio`, `/sessions/${S}/audio/alpha/s1`];

  it.each(routes)("%s without the service token, or with the wrong one, is 401 with no file call and no audit line", async (p) => {
    twoIdentities();
    const { get, append } = await boot();
    hooks.calls = [];
    for (const token of [null, "w".repeat(40)]) {
      const r = await get(p, by(), { token });
      expect(r.status).toBe(401);
      expectJsonEnvelope(r);
    }
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(playedLines(A)).toEqual([]);
  });

  const badBy: [string, Record<string, string | string[]>][] = [
    ["missing", {}],
    ["x", by("x")],
    ["no -console suffix", by("kamal")],
    ["a 57-character name", by(`${"a".repeat(57)}-console`)],
    ["57+ characters", by("a".repeat(60))],
    ["a repeated header (Node joins it with a comma)", by(["kamal-console", "other-console"])],
    ["a space", by("ka mal-console")],
    ["the suffix in another case", by("kamal-CONSOLE")],
  ];
  for (const p of routes) {
    it.each(badBy)(`${p}: X-Acr-By %s is 400 invalid with no file call and no audit line`, async (_label, headers) => {
      twoIdentities();
      const { get, append } = await boot();
      hooks.calls = [];
      const r = await get(p, headers);
      expect(r.status).toBe(400);
      expectJsonEnvelope(r);
      expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "invalid", message: "That request is not valid." } });
      expect(hooks.calls).toEqual([]);
      expect(append).not.toHaveBeenCalled();
      expect(playedLines(A)).toEqual([]);
    });
  }

  it.each(["\u0001", "\u007f", "\t"])("a control character %j in X-Acr-By (written raw on the socket) is 400 with no file call", async (c) => {
    twoIdentities();
    const { append, port } = await boot();
    hooks.calls = [];
    // Node's client refuses to send these, so the request is written by hand.
    const status = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(`GET /sessions/${S}/audio/alpha/s1 HTTP/1.1\r\nHost: x\r\nX-Service-Token: ${TOKEN}\r\nX-Acr-By: ka${c}mal-console\r\nConnection: close\r\n\r\n`, "latin1");
      });
      let text = "";
      sock.on("data", (d) => { text += d.toString("latin1"); });
      sock.on("end", () => resolve(text.split("\r\n")[0] ?? ""));
      sock.on("error", reject);
    });
    expect(status).toMatch(/^HTTP\/1\.1 400 /);
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([
    ["..%2Fx", "s1"], ["s1", "..%2Fx"], ["ALPHA", "s1"], ["alpha", "S1"], ["a".repeat(65), "s1"], ["alpha", "a".repeat(65)],
    ["alpha%00", "s1"], ["alpha", "s1%00"], ["%E0%A4%A", "s1"], ["alpha", "%E0%A4%A"], ["alpha", "s1.wav"], ["alpha", "s%2E1"], ["al%2Fpha", "s1"],
  ])("a bad path id (role %j, segment %j) is 404 with no file call and no audit line", async (role, segment) => {
    twoIdentities();
    const { get, append } = await boot();
    hooks.calls = [];
    const r = await get(`/sessions/${S}/audio/${role}/${segment}`, by());
    expect(r.status).toBe(404);
    expectJsonEnvelope(r);
    expect(json(r.body).error?.code).toBe("not_found");
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it.each(["%E0%A4%A", "a".repeat(65), "bad.id", "%00"])("a bad session id %j is 404 with no file call, on both routes", async (sid) => {
    twoIdentities();
    const { get } = await boot();
    hooks.calls = [];
    for (const p of [`/sessions/${sid}/audio`, `/sessions/${sid}/audio/alpha/s1`]) expect((await get(p, by())).status, p).toBe(404);
    expect(hooks.calls).toEqual([]);
  });

  it("a %2E%2E segment is a dot-dot the URL parser resolves first: it becomes the listing route, never a replay or a file outside", async () => {
    twoIdentities();
    const { get, append } = await boot();
    const r = await get(`/sessions/${S}/audio/alpha/%2E%2E`, by());
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect((json(r.body).data as { identities: number }).identities).toBe(2);
    expect(append).not.toHaveBeenCalled();
  });

  it("a path id is checked before X-Acr-By: a bad id with a bad name is still 404", async () => {
    twoIdentities();
    const { get } = await boot();
    expect((await get(`/sessions/${S}/audio/..%2Fx/s1`, {})).status).toBe(404);
  });

  it.each(["POST", "PUT", "DELETE"])("%s on these paths falls through to not found with no file call", async (method) => {
    twoIdentities();
    const { get } = await boot();
    hooks.calls = [];
    for (const p of routes) expect((await get(p, by(), { method })).status, p).toBe(404);
    expect(hooks.calls).toEqual([]);
  });

  it("with no audio dep both routes are 404", async () => {
    twoIdentities();
    const { get } = await boot({ audio: false });
    hooks.calls = [];
    for (const p of routes) {
      const r = await get(p, by());
      expect(r.status, p).toBe(404);
      expectJsonEnvelope(r);
    }
    expect(hooks.calls).toEqual([]);
  });

  it("extra path segments are not these routes", async () => {
    twoIdentities();
    const { get } = await boot();
    expect((await get(`/sessions/${S}/audio/alpha`, by())).status).toBe(404);
    expect((await get(`/sessions/${S}/audio/alpha/s1/more`, by())).status).toBe(404);
  });
});
