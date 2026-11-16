import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../api.js";
import type { ControlConfig } from "../../config.js";
import { TranscriptService } from "../../voice/transcript.js";
import type { TranscriptRead } from "../../voice/transcript.js";

// A2b-2 Task 2: GET /sessions/:id/transcript, real HTTP against createApi with a real temp sessions dir.
const TOKEN = "t".repeat(40);
const S = "session-1", OTHER = "session-2";
let root: string, sessionsDir: string;
const servers: http.Server[] = [];
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "acr-transcript-route-")); sessionsDir = path.join(root, "sessions"); mkdirSync(sessionsDir); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  rmSync(root, { recursive: true, force: true });
});

const utt = (sessionId: string, seq: number, text: string) => ({ type: "utterance", sessionId, seq, ts: seq * 10, roleId: "coach", channel: "voice", text });
const writeLog = (id: string, events: unknown[]) => writeFileSync(path.join(sessionsDir, `${id}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(""));

type Status = "ended" | "not_ended" | "unknown";
async function boot(o: { status?: (id: string) => Status; isLive?: (id: string) => boolean; maxInFlight?: number; reader?: (d: string, id: string) => TranscriptRead | Promise<TranscriptRead>; service?: false } = {}) {
  const status = vi.fn(o.status ?? ((id: string): Status => (id === S || id === OTHER ? "ended" : "unknown")));
  const transcript = o.service === false ? undefined : new TranscriptService({
    sessionsDir, status, isLive: o.isLive ?? (() => false),
    ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}), ...(o.reader ? { reader: o.reader } : {}),
  });
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: new Proxy({}, { get: () => { throw new Error("supervisor must not be used"); } }) as never,
    scenarios: () => Promise.resolve([]), log: () => {}, ...(transcript ? { transcript } : {}),
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const get = async (p: string, o2: { token?: string | null; headers?: Record<string, string> } = {}) => {
    const token = o2.token === undefined ? TOKEN : o2.token;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { ...(token !== null ? { "x-service-token": token } : {}), ...(o2.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, retryAfter: res.headers.get("retry-after"), json: JSON.parse(text) as { success: boolean; data: any; error: { code: string } | null } };
  };
  return { get, status };
}

describe("GET /sessions/:id/transcript", () => {
  it("401 without the service token, before any status or file call", async () => {
    writeLog(S, [utt(S, 1, "hi")]);
    const { get, status } = await boot();
    expect((await get(`/sessions/${S}/transcript`, { token: null })).status).toBe(401);
    expect((await get(`/sessions/${S}/transcript`, { token: "x".repeat(40) })).status).toBe(401);
    expect(status).not.toHaveBeenCalled();
  });

  it("404 on a bad session id, with no status call", async () => {
    const { get, status } = await boot();
    expect((await get(`/sessions/..%2Fx/transcript`)).status).toBe(404);
    expect((await get(`/sessions/%E0%A4%A/transcript`)).status).toBe(404);
    expect(status).not.toHaveBeenCalled();
  });

  it("404 when the service is not wired", async () => {
    const { get } = await boot({ service: false });
    expect((await get(`/sessions/${S}/transcript`)).status).toBe(404);
  });

  it("404 for an unknown session", async () => {
    writeLog("session-9", [utt("session-9", 1, "hi")]);
    const { get } = await boot();
    expect((await get(`/sessions/session-9/transcript`)).status).toBe(404);
  });

  it.each([["a running session", "not_ended", false], ["a stopped session", "not_ended", false], ["an ended session the voice host is still draining", "ended", true]] as const)(
    "409 session_live for %s, nothing but the code",
    async (_n, st, live) => {
      writeLog(S, [utt(S, 1, "secret words")]);
      const { get } = await boot({ status: () => st, isLive: () => live });
      const r = await get(`/sessions/${S}/transcript`);
      expect(r).toStrictEqual({ status: 409, retryAfter: null, json: { success: false, data: null, error: { code: "session_live" } } });
    },
  );

  it("409 when isLive throws (fails closed)", async () => {
    writeLog(S, [utt(S, 1, "x")]);
    const { get } = await boot({ isLive: () => { throw new Error("boom"); } });
    expect((await get(`/sessions/${S}/transcript`)).status).toBe(409);
  });

  it("200 { lines, truncated: false } for an ended session, utterances only", async () => {
    writeLog(S, [{ type: "session.started", sessionId: S }, utt(S, 1, "hello"), utt(S, 2, "there")]);
    const r = await get_(await boot(), `/sessions/${S}/transcript`);
    expect(r.status).toBe(200);
    expect(r.json.data).toStrictEqual({ lines: [{ seq: 1, ts: 10, roleId: "coach", text: "hello" }, { seq: 2, ts: 20, roleId: "coach", text: "there" }], truncated: false });
  });

  it("413 transcript_too_large over the cap, never a partial list", async () => {
    const { get } = await boot({ reader: () => ({ kind: "too_large" }) });
    const r = await get(`/sessions/${S}/transcript`);
    expect([r.status, r.json.error?.code, r.json.data]).toEqual([413, "transcript_too_large", null]);
  });

  it("404 when the log is missing", async () => {
    const { get } = await boot();
    expect((await get(`/sessions/${S}/transcript`)).status).toBe(404);
  });

  it("503 busy with Retry-After 1 over the in-flight cap; the slot is freed afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const { get } = await boot({ maxInFlight: 1, reader: async () => { calls++; if (calls === 1) await gate; return { kind: "ok", lines: [] }; } });
    const first = get(`/sessions/${S}/transcript`);
    await vi.waitFor(() => expect(calls).toBe(1));
    const busy = await get(`/sessions/${S}/transcript`);
    expect([busy.status, busy.retryAfter, busy.json.error?.code]).toEqual([503, "1", "busy"]);
    release();
    expect((await first).status).toBe(200);
    expect((await get(`/sessions/${S}/transcript`)).status).toBe(200);
  });

  it("needs no X-Acr-By and writes no audit line", async () => {
    writeLog(S, [utt(S, 1, "hi")]);
    const { get } = await boot();
    expect((await get(`/sessions/${S}/transcript`)).status).toBe(200);
    expect(existsSync(path.join(root, "audio"))).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([`${S}.jsonl`]);
  });

  it("another session's lines inside this log are not returned, and another log is never read", async () => {
    writeLog(S, [utt(S, 1, "mine"), utt(OTHER, 2, "theirs")]);
    writeLog(OTHER, [utt(OTHER, 1, "other log")]);
    const { get } = await boot();
    const r = await get(`/sessions/${S}/transcript`);
    expect(r.json.data.lines).toStrictEqual([{ seq: 1, ts: 10, roleId: "coach", text: "mine" }]);
  });
});

async function get_(b: Awaited<ReturnType<typeof boot>>, p: string) { return b.get(p); }
