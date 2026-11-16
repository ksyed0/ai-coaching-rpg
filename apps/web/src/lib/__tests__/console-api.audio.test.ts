import { describe, expect, it, vi } from "vitest";
import { deleteAudio, fetchAudioList, audioFailureText, playClip } from "../console-api";
import { AUDIO_CONSOLE, AUDIO_REFUSALS } from "../messages";

// A2b-2: the browser's audio calls. Everything from the network is untrusted; a malformed clip fails the whole list.

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const env = (data: unknown) => ({ success: true, data, error: null });
const err = (code: string, data: unknown = null) => ({ success: false, data, error: { code, message: "server text" } });
const clip = { role: "tech_lead", segment: "s1", startMs: 0, endMs: 2000, status: "transcribed", audio: "available", text: "hello" };
const fx = (res: Response | Error) => vi.fn(async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("test_fetchAudioList", () => {
  it("parses a valid answer", async () => {
    const f = fx(json(200, env({ recordingStopped: true, clips: [clip, { ...clip, segment: "s2", text: undefined, audio: "deleted" }], tooLongForText: true })));
    const r = await fetchAudioList(f, "sess1");
    expect(r).toEqual({
      ok: true,
      data: {
        recordingStopped: true, textUnavailable: false, tooLongForText: true,
        clips: [clip, { role: "tech_lead", segment: "s2", startMs: 0, endMs: 2000, status: "transcribed", audio: "deleted" }],
      },
    });
    expect((f as any).mock.calls[0][0]).toBe("/api/v1/console/sessions/sess1/audio");
  });

  it("rejects a clip with a non-string role", async () => {
    const r = await fetchAudioList(fx(json(200, env({ recordingStopped: false, clips: [{ ...clip, role: 7 }] }))), "sess1");
    expect(r).toEqual({ ok: false, code: "invalid" });
  });

  it("rejects a bad audio state, a negative time and a non-list", async () => {
    for (const bad of [{ ...clip, audio: "x" }, { ...clip, startMs: -1 }, { ...clip, text: 3 }]) {
      expect((await fetchAudioList(fx(json(200, env({ recordingStopped: false, clips: [bad] }))), "s")).ok).toBe(false);
    }
    expect((await fetchAudioList(fx(json(200, env({ recordingStopped: false, clips: "x" }))), "s")).ok).toBe(false);
  });

  it("maps 403 account_required and a network failure", async () => {
    expect(await fetchAudioList(fx(json(403, err("account_required"))), "s")).toEqual({ ok: false, code: "account_required" });
    expect(await fetchAudioList(fx(new Error("down")), "s")).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("test_playClip", () => {
  it("returns a Blob with audio/wav", async () => {
    const f = fx(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/wav" } }));
    const r = await playClip(f, "sess1", "tech_lead", "s1");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.blob.type).toBe("audio/wav"); expect(r.blob.size).toBe(3); }
    expect((f as any).mock.calls[0][0]).toBe("/api/v1/console/sessions/sess1/audio/play?role=tech_lead&segment=s1");
  });

  it("maps 410 to audio_deleted and 503 busy", async () => {
    expect(await playClip(fx(json(410, err("audio_deleted"))), "s", "r", "g")).toEqual({ ok: false, code: "audio_deleted" });
    expect(await playClip(fx(json(503, err("busy"))), "s", "r", "g")).toEqual({ ok: false, code: "busy" });
  });

  it("refuses a success that is not audio/wav, and a network failure", async () => {
    expect((await playClip(fx(new Response("x", { status: 200, headers: { "Content-Type": "text/html" } })), "s", "r", "g")).ok).toBe(false);
    expect(await playClip(fx(new Error("down")), "s", "r", "g")).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("test_deleteAudio", () => {
  const scope = { kind: "session" } as const;
  it("200 is done", async () => {
    const f = fx(json(200, env({ state: "done", deleted: 3, done: 2, pending: [] })));
    expect(await deleteAudio(f, "sess1", scope, "facilitator")).toEqual({ state: "done", deleted: 3, pending: [] });
    const [path, init] = (f as any).mock.calls[0];
    expect(path).toBe("/api/v1/console/sessions/sess1/audio/delete");
    expect(JSON.parse(init.body)).toEqual({ scope, reason: "facilitator" });
  });

  it("503 with a partial body is pending with its reasons, not an error", async () => {
    const r = await deleteAudio(fx(json(503, err("busy", { state: "pending", deleted: 1, done: 0, pending: [{ reason: "busy" }, { reason: "store_unsafe" }] }))), "s", scope, "facilitator");
    expect(r).toEqual({ state: "pending", deleted: 1, pending: [{ reason: "busy" }, { reason: "store_unsafe" }], code: "busy" });
  });

  it("409 is live with its partial body; 503 without a body is failed", async () => {
    const live = await deleteAudio(fx(json(409, err("session_live", { state: "live", deleted: 0, done: 0, pending: [] }))), "s", scope, "participant_request");
    expect(live).toMatchObject({ state: "live", deleted: 0, code: "session_live" });
    expect(await deleteAudio(fx(json(503, err("busy"))), "s", scope, "facilitator")).toMatchObject({ state: "failed", code: "busy", deleted: 0 });
  });

  it("403 account_required is refused; a network failure is failed", async () => {
    expect(await deleteAudio(fx(json(403, err("account_required"))), "s", scope, "facilitator")).toEqual({ state: "refused", deleted: 0, pending: [], code: "account_required" });
    expect(await deleteAudio(fx(new Error("down")), "s", scope, "facilitator")).toMatchObject({ state: "failed", deleted: 0, pending: [] });
  });

  it("a 200 whose body is malformed is failed, never done", async () => {
    expect((await deleteAudio(fx(json(200, env({ state: "done", deleted: "3" }))), "s", scope, "facilitator")).state).toBe("failed");
  });
});

describe("test_audioFailureText", () => {
  it("maps known codes to the fixed sentences and unknown to generic", () => {
    expect(audioFailureText("account_required")).toBe(AUDIO_REFUSALS.account_required);
    expect(audioFailureText("audio_deleted")).toBe(AUDIO_REFUSALS.audio_deleted);
    expect(audioFailureText("whatever")).toBe(AUDIO_REFUSALS.generic);
  });
  it("copy: heading, note and confirmation sentence", () => {
    expect(AUDIO_CONSOLE.heading).toBe("Recordings");
    expect(AUDIO_CONSOLE.logged).toBe("Each play is logged.");
    expect(AUDIO_CONSOLE.confirmSession(3, 125000)).toBe("This permanently deletes 3 clips (2 min 5 s). It cannot be undone.");
    expect(AUDIO_CONSOLE.confirmSession(1, 4000)).toBe("This permanently deletes 1 clip (0 min 4 s). It cannot be undone.");
    expect(AUDIO_CONSOLE.reasonLabel.facilitator).toBe("Facilitator decision");
    expect(AUDIO_CONSOLE.pendingReason.busy).toBe("try again");
    expect(AUDIO_CONSOLE.pendingReason.store_unsafe).toBe("needs the operator");
  });
});
