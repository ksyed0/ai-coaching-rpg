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
    readFileSync: wrap("readFileSync"), mkdirSync: wrap("mkdirSync"), accessSync: wrap("accessSync"), unlinkSync: wrap("unlinkSync"),
    renameSync: wrap("renameSync"), writeFileSync: wrap("writeFileSync"),
    existsSync: ((p: string) => { rec("existsSync", p); return actual.existsSync(p); }) as typeof actual.existsSync,
  };
});
const fs = await import("node:fs");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } = fs;
const { createApi } = await import("../../api.js");
const { AudioCatalog } = await import("../../voice/audio-catalog.js");
const { AuditLog } = await import("../../voice/audit-log.js");
const { AudioService, parseBy } = await import("../../voice/audio-routes.js");
const { IdentityMutex } = await import("../../voice/store-lock.js");
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
const delLine = (segment: string) => ({ v: 1, kind: "deleted", segment, op: "0123456789abcdef", ts: 1 });
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
async function boot(o: {
  audit?: Audit; maxInFlight?: number; audio?: false; catalog?: InstanceType<typeof AudioCatalog>;
  /** US-0075: the delete's deps. */
  isLive?: (id: string) => boolean; mutex?: InstanceType<typeof IdentityMutex>; maxDeletesInFlight?: number;
} = {}) {
  const real = new AuditLog({ audioDir, now: () => 1234 });
  const append = vi.fn((identity: string, e: AuditEvent) => (o.audit ?? real).append(identity, e));
  const catalog = o.catalog ?? new AudioCatalog({ audioDir });
  const audio = o.audio === false ? undefined
    : new AudioService({
      catalog, audit: { append }, audioDir, ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}),
      ...(o.isLive ? { isLive: o.isLive } : {}), ...(o.mutex ? { mutex: o.mutex } : {}),
      ...(o.maxDeletesInFlight !== undefined ? { maxDeletesInFlight: o.maxDeletesInFlight } : {}),
    });
  const log = vi.fn((_m: string) => {});
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: untouchable as never, scenarios: () => Promise.resolve([]), log,
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
  /** A DELETE with a body: an object is sent as JSON, a string as written (with `type` as its Content-Type), undefined as no body. */
  const del = (p: string, body: unknown, headers: Record<string, string | string[]> = {}, o2: { token?: string | null; type?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const h: Record<string, string | string[]> = { ...headers };
      const token = o2.token === undefined ? TOKEN : o2.token;
      if (token !== null) h["x-service-token"] = token;
      const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      if (text !== "") { h["content-type"] = o2.type ?? "application/json"; h["content-length"] = String(Buffer.byteLength(text)); }
      const req = http.request({ host: "127.0.0.1", port, path: p, method: "DELETE", headers: h, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(text);
    });
  return { get, del, append, port, log };
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

  it("an untrusted role index is 503 store_unsafe with no Retry-After, no audio byte and no audit line (US-0075)", async () => {
    const { s1 } = twoIdentities();
    // A's alpha index becomes a link to a valid copy elsewhere: it cannot be trusted, so the replay fails closed.
    const idx = path.join(audioDir, A, "alpha", "index.jsonl");
    const moved = path.join(root, "moved-index.jsonl");
    renameSync(idx, moved);
    symlinkSync(moved, idx);
    const { get, append } = await boot();
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(503);
    expectJsonEnvelope(r);
    expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "store_unsafe" } });
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(r.body.includes(s1.subarray(0, 16))).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(playedLines(A)).toEqual([]);
    // the listing still answers: the untrusted role is omitted, the other identity's segments are listed
    const list = await get(`/sessions/${S}/audio`, by());
    expect(list.status).toBe(200);
    expect((json(list.body).data as { segments: { identity: string; role: string; segment: string }[] }).segments.map((x) => `${x.role}/${x.segment}`))
      .toEqual(["beta/s2", "beta/s3"]);
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

  it("positive control: the fs-call seam is live (a 200 replay and a 200 listing record file calls), so the empty-call assertions mean something", async () => {
    const { s1 } = twoIdentities();
    const { get } = await boot();
    hooks.calls = [];
    const r = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(r.status).toBe(200);
    expect(r.body.equals(s1)).toBe(true);
    expect(hooks.calls.length).toBeGreaterThan(0);
    expect(hooks.calls.some((c) => c.startsWith("openSync ") && c.endsWith(path.join(A, "alpha", "s1.wav")))).toBe(true);
    hooks.calls = [];
    expect((await get(`/sessions/${S}/audio`, by())).status).toBe(200);
    expect(hooks.calls.length).toBeGreaterThan(0);
  });

  // DELETE on the listing path is the delete route (US-0075, its own tests below); DELETE on the replay path still falls through.
  it.each(["HEAD", "POST", "PUT", "DELETE"])("%s on these paths falls through to not found with no file call, no audit line and no audio bytes", async (method) => {
    const { s1 } = twoIdentities();
    const { get, append } = await boot();
    hooks.calls = [];
    for (const p of method === "DELETE" ? routes.slice(1) : routes) {
      const r = await get(p, by(), { method });
      expect(r.status, p).toBe(404);
      expect(r.headers["content-type"], p).not.toBe("audio/wav");
      expect(r.body.includes(s1.subarray(0, 16)), p).toBe(false);
    }
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(playedLines(A)).toEqual([]);
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

// --- US-0075 (voice A2b-1b, Task 8): DELETE /sessions/:id/audio ---
type Outcome = { deleted: number; gone: string[]; identities: { identity: string; deleted: number; state: string }[]; pending: { identity: string; reason: string }[] };
const SESSION_BODY = { scope: { kind: "session" }, reason: "facilitator", by: BY };
const C = id(0xc), D = id(0xd);
const deletedLines = (identity: string) => auditLines(identity).filter((l) => l.type === "audio.deleted");
const wavExists = (identity: string, role: string, segment: string): boolean => {
  const was = hooks.calls; hooks.calls = null;
  try { return existsSync(path.join(audioDir, identity, role, `${segment}.wav`)); } finally { hooks.calls = was; }
};
/** Nothing a caller or the log sees names the store: no temp root, no audio folder, no file name. */
function expectNoPath(texts: string[]): void {
  for (const t of texts) {
    expect(t).not.toContain(root);
    expect(t).not.toContain(audioDir);
    expect(t).not.toContain(".wav");
    expect(t).not.toContain("index.jsonl");
    expect(t).not.toContain("session.json");
  }
}
/** An audit whose append answers false for the given identities and appends for real otherwise. */
const auditFailingFor = (...ids: string[]): Audit => {
  const real = new AuditLog({ audioDir, now: () => 1234 });
  return { append: async (i, e) => (ids.includes(i) ? false : real.append(i, e)) };
};
/** Makes `identity`'s role index a link to a valid copy elsewhere: it cannot be trusted. */
function linkIndex(identity: string, role: string): void {
  const idx = path.join(audioDir, identity, role, "index.jsonl");
  const moved = path.join(root, `moved-${identity}-${role}.jsonl`);
  renameSync(idx, moved);
  symlinkSync(moved, idx);
}

describe("DELETE /sessions/:id/audio: refusals before any file call", () => {
  it("without the service token, or with the wrong one, is 401 with no file call and no audit line", async () => {
    twoIdentities();
    const { del, append } = await boot();
    hooks.calls = [];
    for (const token of [null, "w".repeat(40)]) {
      const r = await del(`/sessions/${S}/audio`, SESSION_BODY, by(), { token });
      expect(r.status).toBe(401);
      expectJsonEnvelope(r);
      expect(json(r.body).error?.code).toBe("unauthorized");
    }
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(wavExists(A, "alpha", "s1")).toBe(true);
  });

  it.each(["%E0%A4%A", "a".repeat(65), "bad.id", "%00"])("a bad session id %j is 404 with no file call", async (sid) => {
    twoIdentities();
    const { del, append } = await boot();
    hooks.calls = [];
    const r = await del(`/sessions/${sid}/audio`, SESSION_BODY);
    expect(r.status).toBe(404);
    expectJsonEnvelope(r);
    expect(json(r.body).error?.code).toBe("not_found");
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("with no audio dep it is 404 with no file call", async () => {
    twoIdentities();
    const { del } = await boot({ audio: false });
    hooks.calls = [];
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(404);
    expectJsonEnvelope(r);
    expect(hooks.calls).toEqual([]);
    expect(wavExists(A, "alpha", "s1")).toBe(true);
  });

  it("DELETE on a longer audio path is not the route (404, nothing deleted)", async () => {
    twoIdentities();
    const { del, append } = await boot();
    hooks.calls = [];
    for (const p of [`/sessions/${S}/audio/alpha`, `/sessions/${S}/audio/alpha/s1`]) expect((await del(p, SESSION_BODY)).status, p).toBe(404);
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  const P = (participant: unknown) => ({ scope: { kind: "participant", participant }, reason: "facilitator", by: BY });
  const badBodies: [string, unknown, Record<string, string | string[]>?, { type?: string }?][] = [
    ["no body", undefined],
    ["an empty object", {}],
    ["not JSON", "{not json", {}, {}],
    ["a JSON body sent as text/plain", JSON.stringify(SESSION_BODY), {}, { type: "text/plain" }],
    ["a JSON array", [SESSION_BODY]],
    ["null", "null"],
    ["an unknown top-level key", { ...SESSION_BODY, extra: 1 }],
    ["an unknown key in the scope", { ...SESSION_BODY, scope: { kind: "session", all: true } }],
    ["two scope kinds (session + role)", { ...SESSION_BODY, scope: { kind: "session", role: "alpha" } }],
    ["two scope kinds (role + participant)", { ...SESSION_BODY, scope: { kind: "role", role: "alpha", participant: "p-s1" } }],
    ["an unknown scope kind", { ...SESSION_BODY, scope: { kind: "identity" } }],
    ["a scope with no kind", { ...SESSION_BODY, scope: {} }],
    ["no scope", { reason: "facilitator", by: BY }],
    ["a role scope with no role", { ...SESSION_BODY, scope: { kind: "role" } }],
    ["a role that is not file-safe (a path)", { ...SESSION_BODY, scope: { kind: "role", role: "../alpha" } }],
    ["a role with a slash", { ...SESSION_BODY, scope: { kind: "role", role: "al/pha" } }],
    ["a non-string role", { ...SESSION_BODY, scope: { kind: "role", role: 1 } }],
    ["an empty participant", P("")],
    ["a 129-character participant", P("p".repeat(129))],
    ["the rebind-pending participant", P("rebind-pending")],
    ["a non-string participant", P(7)],
    ["a reason outside the enum", { ...SESSION_BODY, reason: "expired" }],
    ["no reason", { scope: { kind: "session" }, by: BY }],
    ["no by in the body (even with the header)", { scope: { kind: "session" }, reason: "facilitator" }, by()],
    ["a bad by (no -console)", { ...SESSION_BODY, by: "kamal" }],
    ["a bad by (57-character name)", { ...SESSION_BODY, by: `${"a".repeat(57)}-console` }],
    ["a non-string by", { ...SESSION_BODY, by: 5 }],
    ["an X-Acr-By header that differs from body.by", SESSION_BODY, by("other-console")],
    ["a repeated X-Acr-By header", SESSION_BODY, by([BY, BY])],
  ];
  it.each(badBodies)("%s is 400 invalid (the GET route's bad-by answer) with no file call and no audit line", async (_label, body, headers = {}, o2 = {}) => {
    twoIdentities();
    const { del, append } = await boot();
    hooks.calls = [];
    const r = await del(`/sessions/${S}/audio`, body, headers, o2);
    expect(r.status).toBe(400);
    expectJsonEnvelope(r);
    expect(json(r.body)).toStrictEqual({ success: false, data: null, error: { code: "invalid", message: "That request is not valid." } });
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(wavExists(A, "alpha", "s1")).toBe(true);
  });

  const OVERSIZE = { ...SESSION_BODY, scope: { kind: "participant", participant: "p" }, pad: "x".repeat(5000) };
  /** The 413 every other body route gives: payload_too_large, the connection closed, no file call, no audit line, nothing removed. */
  function expectTooLarge(r: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }, append: unknown): void {
    expect(r.status).toBe(413);
    expectJsonEnvelope(r);
    expect(json(r.body).error?.code).toBe("payload_too_large");
    expect(r.headers.connection).toBe("close");
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(wavExists(A, "alpha", "s1")).toBe(true);
  }

  it("a body over 4096 bytes with a declared Content-Length is 413 payload_too_large (like every other body route), not 400", async () => {
    twoIdentities();
    const { del, append } = await boot();
    hooks.calls = [];
    expectTooLarge(await del(`/sessions/${S}/audio`, OVERSIZE), append);
  });

  it("a streamed (chunked, undeclared) body over 4096 bytes is 413 payload_too_large", async () => {
    twoIdentities();
    const { append, port } = await boot();
    hooks.calls = [];
    const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      let answered = false;
      const req = http.request({
        host: "127.0.0.1", port, path: `/sessions/${S}/audio`, method: "DELETE", agent: false,
        headers: { "x-service-token": TOKEN, "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", (e) => { if (!answered) reject(e); }); // the server may close while the rest is still being written
      req.end(JSON.stringify(OVERSIZE));
    });
    expect(r.headers["content-length"]).toBeDefined();
    expectTooLarge(r, append);
  });

  it("live (VoiceHost.isLive) is 409 session_live with the empty outcome body and NO file call: checked before the catalog", async () => {
    twoIdentities();
    const isLive = vi.fn(() => true);
    const { del, append } = await boot({ isLive });
    hooks.calls = [];
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(409);
    expectJsonEnvelope(r);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({ success: false, data: { deleted: 0, gone: [], identities: [], pending: [] }, error: { code: "session_live" } });
    expect(hooks.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(isLive).toHaveBeenCalledWith(S);
    expect(wavExists(A, "alpha", "s1")).toBe(true);
  });

  it("an isLive that throws counts as live (409, no file call)", async () => {
    twoIdentities();
    const { del } = await boot({ isLive: () => { throw new Error("boom"); } });
    hooks.calls = [];
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(409);
    expect(json(r.body).error?.code).toBe("session_live");
    expect(hooks.calls).toEqual([]);
  });
});

describe("DELETE /sessions/:id/audio: outcomes", () => {
  it("session scope: 200 with every identity done, the WAVs gone, one audio.deleted line each, and replay then 410", async () => {
    twoIdentities();
    const { del, get } = await boot();
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY, by());
    expect(r.status).toBe(200);
    expectJsonEnvelope(r);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({
      success: true, error: null,
      data: { deleted: 2, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }, { identity: B, deleted: 1, state: "done" }], pending: [] },
    });
    expect(wavExists(A, "alpha", "s1")).toBe(false);
    expect(wavExists(B, "beta", "s2")).toBe(false);
    for (const i of [A, B]) {
      const lines = deletedLines(i);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ type: "audio.deleted", scope: { kind: "session" }, reason: "facilitator", by: BY, segments: 1 });
    }
    expect((await get(`/sessions/${S}/audio/alpha/s1`, by())).status).toBe(410);
    expect((await get(`/sessions/${S}/audio/beta/s2`, by())).status).toBe(410);
  });

  it("a retry when everything is already deleted is a normal 200 with deleted 0", async () => {
    twoIdentities();
    const { del } = await boot();
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(200);
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({
      deleted: 0, gone: [], identities: [{ identity: A, deleted: 0, state: "done" }, { identity: B, deleted: 0, state: "done" }], pending: [],
    });
  });

  it("role scope: only that role's segments go", async () => {
    twoIdentities();
    const { del } = await boot();
    const r = await del(`/sessions/${S}/audio`, { scope: { kind: "role", role: "beta" }, reason: "facilitator", by: BY });
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({
      deleted: 1, gone: [], identities: [{ identity: A, deleted: 0, state: "done" }, { identity: B, deleted: 1, state: "done" }], pending: [],
    });
    expect(wavExists(A, "alpha", "s1")).toBe(true);
    expect(wavExists(B, "beta", "s2")).toBe(false);
    expect(deletedLines(A)).toEqual([]); // a facilitator request with nothing in scope writes nothing
    expect(deletedLines(B)[0]).toMatchObject({ scope: { kind: "role", role: "beta" }, segments: 1 });
  });

  it("participant scope (participant_request): only that participant's segments go, across identities; the id is compared, never a path", async () => {
    twoIdentities();
    const { del } = await boot();
    const r = await del(`/sessions/${S}/audio`, { scope: { kind: "participant", participant: "p-s1" }, reason: "participant_request", by: BY });
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({
      deleted: 1, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }, { identity: B, deleted: 0, state: "done" }], pending: [],
    });
    expect(wavExists(A, "alpha", "s1")).toBe(false);
    expect(wavExists(B, "beta", "s2")).toBe(true);
    expect(deletedLines(A)[0]).toMatchObject({ scope: { kind: "participant", participant: "p-s1" }, reason: "participant_request", segments: 1 });
    expect(deletedLines(B)[0]).toMatchObject({ reason: "participant_request", segments: 0 }); // proof the request was honoured
  });

  it("a 128-character participant and a matching X-Acr-By header are accepted", async () => {
    twoIdentities();
    const { del } = await boot();
    const r = await del(`/sessions/${S}/audio`, { scope: { kind: "participant", participant: "p".repeat(128) }, reason: "facilitator", by: BY }, by());
    expect(r.status).toBe(200);
    expect((json(r.body).data as Outcome).deleted).toBe(0);
  });

  it("an identity the catalog found but that no longer belongs under the lock is listed in gone (200)", async () => {
    twoIdentities();
    const catalog = new AudioCatalog({ audioDir });
    vi.spyOn(catalog, "find").mockResolvedValue([A, D]); // D has no folder
    const { del } = await boot({ catalog });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({ deleted: 1, gone: [D], identities: [{ identity: A, deleted: 1, state: "done" }], pending: [] });
  });

  it("an unknown session (and one whose only folder has no marker) is 404 with the listing's no-audio answer", async () => {
    twoIdentities();
    mkIdentity(C, null);
    const { del, get } = await boot();
    const listing = await get(`/sessions/${OTHER}/audio`, by());
    for (const sid of [OTHER, "nobody"]) {
      const r = await del(`/sessions/${sid}/audio`, SESSION_BODY);
      expect(r.status).toBe(404);
      expectJsonEnvelope(r);
      expect(json(r.body)).toStrictEqual(json(listing.body));
      expect(json(r.body).error).toStrictEqual({ code: "not_found", message: "That session has no audio." });
    }
  });

  it("an upper-case session id works", async () => {
    const UP = "Session-UPPER";
    mkIdentity(C, UP);
    mkRole(C, "alpha", [segLine("s9", 100)], { s9: wavBytes(100) });
    const { del } = await boot();
    const r = await del(`/sessions/${UP}/audio`, SESSION_BODY);
    expect(r.status).toBe(200);
    expect(json(r.body).data).toStrictEqual({ deleted: 1, gone: [], identities: [{ identity: C, deleted: 1, state: "done" }], pending: [] });
    expect(wavExists(C, "alpha", "s9")).toBe(false);
  });

  it("live after some identities are done: 409 session_live carrying the work done so far", async () => {
    twoIdentities();
    let calls = 0;
    // service (1), deleteAudio before the loop (2), before A (3), before B (4): live from the 4th ask on
    const { del } = await boot({ isLive: () => ++calls >= 4 });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(409);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({
      success: false, data: { deleted: 1, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }], pending: [] }, error: { code: "session_live" },
    });
    expect(wavExists(B, "beta", "s2")).toBe(true);
  });

  it("an identity held by the sweep or another delete is 503 busy with Retry-After: 1 and the partial body; a retry finishes it", async () => {
    twoIdentities();
    const mutex = new IdentityMutex();
    const releaseB = mutex.tryTake(B)!;
    const { del } = await boot({ mutex });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(503);
    expectJsonEnvelope(r);
    expect(r.headers["retry-after"]).toBe("1");
    expect(json(r.body)).toStrictEqual({
      success: false, data: { deleted: 1, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }], pending: [{ identity: B, reason: "busy" }] },
      error: { code: "busy" },
    });
    expect(wavExists(B, "beta", "s2")).toBe(true);
    releaseB();
    const again = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(again.status).toBe(200);
    expect((json(again.body).data as Outcome).deleted).toBe(1);
    expect(wavExists(B, "beta", "s2")).toBe(false);
  });

  it("an identity whose folder can no longer be judged under the lock (a file in its place) is 503 store_unsafe, not gone", async () => {
    twoIdentities();
    const catalog = new AudioCatalog({ audioDir });
    const aside = path.join(root, "aside-A");
    vi.spyOn(catalog, "find").mockImplementation(async () => {
      renameSync(path.join(audioDir, A), aside);
      writeFileSync(path.join(audioDir, A), "x");
      return [A];
    });
    const { del, append } = await boot({ catalog });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(503);
    expectJsonEnvelope(r);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({
      success: false, data: { deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] }, error: { code: "store_unsafe" },
    });
    expect(append).not.toHaveBeenCalled();
    expect(existsSync(path.join(aside, "alpha", "s1.wav"))).toBe(true);
  });

  it("an untrusted index is 503 store_unsafe with NO Retry-After and the partial body", async () => {
    twoIdentities();
    linkIndex(A, "alpha");
    const { del } = await boot();
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({
      success: false, data: { deleted: 1, gone: [], identities: [{ identity: B, deleted: 1, state: "done" }], pending: [{ identity: A, reason: "store_unsafe" }] },
      error: { code: "store_unsafe" },
    });
    expect(deletedLines(A)).toEqual([]);
  });

  it("an audit that cannot append is 503 audit_unavailable with NO Retry-After, and that identity keeps its audio", async () => {
    twoIdentities();
    const { del } = await boot({ audit: auditFailingFor(B) });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(json(r.body)).toStrictEqual({
      success: false, data: { deleted: 1, gone: [], identities: [{ identity: A, deleted: 1, state: "done" }], pending: [{ identity: B, reason: "audit_unavailable" }] },
      error: { code: "audit_unavailable" },
    });
    expect(wavExists(B, "beta", "s2")).toBe(true);
  });

  /** Three identities of S: A (alpha), B (beta), C (gamma), each with one WAV. */
  function threeIdentities(): void {
    for (const [i, role, seg] of [[A, "alpha", "s1"], [B, "beta", "s2"], [C, "gamma", "s3"]] as const) {
      mkIdentity(i);
      mkRole(i, role, [segLine(seg, 100)], { [seg]: wavBytes(100) });
    }
  }
  it.each([
    ["busy + audit_unavailable", { busy: [A], audit: [B], unsafe: [] as string[] }, "audit_unavailable"],
    ["busy + store_unsafe", { busy: [A], audit: [], unsafe: [B] }, "store_unsafe"],
    ["audit_unavailable + store_unsafe", { busy: [], audit: [A], unsafe: [B] }, "store_unsafe"],
    ["all three", { busy: [C], audit: [A], unsafe: [B] }, "store_unsafe"],
  ])("worst reason first (%s): the code is %s, Retry-After only for busy", async (_label, o, code) => {
    threeIdentities();
    const roles: Record<string, string> = { [A]: "alpha", [B]: "beta", [C]: "gamma" };
    for (const i of o.unsafe) linkIndex(i, roles[i]!);
    const mutex = new IdentityMutex();
    for (const i of o.busy) mutex.tryTake(i);
    const { del } = await boot({ mutex, audit: auditFailingFor(...o.audit) });
    const r = await del(`/sessions/${S}/audio`, SESSION_BODY);
    expect(r.status).toBe(503);
    expect(json(r.body).error).toStrictEqual({ code });
    expect(r.headers["retry-after"]).toBeUndefined();
    const reasons = Object.fromEntries((json(r.body).data as Outcome).pending.map((p) => [p.identity, p.reason]));
    expect(reasons).toStrictEqual(Object.fromEntries([...o.busy.map((i) => [i, "busy"]), ...o.audit.map((i) => [i, "audit_unavailable"]), ...o.unsafe.map((i) => [i, "store_unsafe"])]));
  });

  it("5 concurrent deletes while 4 are held open: the 5th is 503 busy at once with Retry-After: 1, and the slot comes back", async () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((n) => ({ sid: `session-c${n}`, identity: id(0x100 + n) }));
    for (const { sid, identity } of sessions) { mkIdentity(identity, sid); mkRole(identity, "alpha", [segLine("s1", 100)], { s1: wavBytes(100) }); }
    const real = new AuditLog({ audioDir, now: () => 1234 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0, slow = true;
    let allHeld!: () => void;
    const four = new Promise<void>((r) => { allHeld = r; });
    const { del } = await boot({ audit: { append: async (i, e) => { if (slow) { held++; if (held === 4) allHeld(); await gate; } return real.append(i, e); } } });
    const first = sessions.slice(0, 4).map(({ sid }) => del(`/sessions/${sid}/audio`, SESSION_BODY));
    await four;
    hooks.calls = [];
    const fifth = await del(`/sessions/${sessions[4]!.sid}/audio`, SESSION_BODY);
    expect(fifth.status).toBe(503);
    expectJsonEnvelope(fifth);
    expect(fifth.headers["retry-after"]).toBe("1");
    expect(json(fifth.body).error?.code).toBe("busy");
    expect(json(fifth.body).data).toBeNull();
    expect(hooks.calls).toEqual([]); // refused before any file call
    expect(held).toBe(4);
    slow = false;
    release();
    for (const r of await Promise.all(first)) expect(r.status).toBe(200);
    expect((await del(`/sessions/${sessions[4]!.sid}/audio`, SESSION_BODY)).status).toBe(200);
    expect((await del(`/sessions/${sessions[5]!.sid}/audio`, SESSION_BODY)).status).toBe(200);
  });

  it("the delete cap is its own: 4 deletes held open do not stop a replay", async () => {
    const { s1 } = twoIdentities();
    const sessions = [1, 2, 3, 4].map((n) => ({ sid: `session-c${n}`, identity: id(0x100 + n) }));
    for (const { sid, identity } of sessions) { mkIdentity(identity, sid); mkRole(identity, "alpha", [segLine("s1", 100)], { s1: wavBytes(100) }); }
    const real = new AuditLog({ audioDir, now: () => 1234 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    let allHeld!: () => void;
    const four = new Promise<void>((r) => { allHeld = r; });
    const { del, get } = await boot({
      audit: { append: async (i, e) => { if (e.type === "audio.deleted") { held++; if (held === 4) allHeld(); await gate; } return real.append(i, e); } },
    });
    const first = sessions.map(({ sid }) => del(`/sessions/${sid}/audio`, SESSION_BODY));
    await four;
    const play = await get(`/sessions/${S}/audio/alpha/s1`, by());
    expect(play.status).toBe(200);
    expect(play.body.equals(s1)).toBe(true);
    release();
    for (const r of await Promise.all(first)) expect(r.status).toBe(200);
  });

  it("the slot is freed on every path: success, 404, 409, 503 pending and a throw (cap 1)", async () => {
    twoIdentities();
    const catalog = new AudioCatalog({ audioDir });
    const find = vi.spyOn(catalog, "find");
    let live = false;
    const mutex = new IdentityMutex();
    const { del } = await boot({ catalog, mutex, maxDeletesInFlight: 1, isLive: () => live });
    // a throw: an identity list whose iteration fails escapes deleteAudio (500)
    find.mockResolvedValueOnce({ length: 1, [Symbol.iterator]: () => { throw new Error("boom"); } } as unknown as string[]);
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(500);
    expect((await del(`/sessions/${OTHER}/audio`, SESSION_BODY)).status).toBe(404);
    live = true;
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(409);
    live = false;
    const releaseA = mutex.tryTake(A)!;
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(503);
    releaseA();
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(200);
    expect((await del(`/sessions/${S}/audio`, SESSION_BODY)).status).toBe(200);
  });

  it("nothing in any response, and nothing logged, contains a path", async () => {
    twoIdentities();
    linkIndex(B, "beta");
    const catalog = new AudioCatalog({ audioDir });
    const find = vi.spyOn(catalog, "find");
    const { del, log } = await boot({ catalog });
    const texts: string[] = [];
    const push = (r: { body: Buffer; headers: http.IncomingHttpHeaders }) => { texts.push(r.body.toString("utf8"), JSON.stringify(r.headers)); };
    push(await del(`/sessions/${S}/audio`, SESSION_BODY)); // 503 store_unsafe with A done
    push(await del(`/sessions/${S}/audio`, { ...SESSION_BODY, extra: 1 })); // 400
    push(await del(`/sessions/${OTHER}/audio`, SESSION_BODY)); // 404
    find.mockResolvedValueOnce({ length: 1, [Symbol.iterator]: () => { throw new Error(`boom ${audioDir}`); } } as unknown as string[]);
    push(await del(`/sessions/${S}/audio`, SESSION_BODY)); // 500
    expect(texts.join("")).toContain(A); // positive control: the body is there to search
    expectNoPath([...texts, ...log.mock.calls.map((c) => String(c[0]))]);
    expect(log).toHaveBeenCalled(); // positive control: the 500 was logged (by error name only)
  });
});

describe("production code never sets deleteAudio's acquireLock test seam", () => {
  const src = path.resolve(import.meta.dirname, "../..");
  const read = (rel: string): string => fs.readFileSync(path.join(src, rel), "utf8");
  it("audio-routes.ts, api.ts and main.ts never name acquireLock", () => {
    for (const rel of ["voice/audio-routes.ts", "api.ts", "main.ts"]) expect(read(rel), rel).not.toMatch(/acquireLock/);
  });
  it("audio-routes.ts is the only non-test caller of deleteAudio (so the scan above covers every caller)", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); continue; }
        if (e.name.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("deleteAudio(")) callers.push(path.relative(src, p));
      }
    };
    walk(src);
    expect(callers.sort()).toStrictEqual(["voice/audio-delete.ts", "voice/audio-routes.ts"]);
  });
});
