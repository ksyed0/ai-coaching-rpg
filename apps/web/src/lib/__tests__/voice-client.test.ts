import { beforeEach, describe, expect, it, vi } from "vitest";
import { tokenFetcher, VoiceClient, type TokenAnswer } from "../voice-client";
import { MESSAGES } from "../messages";
import type { ActionResult } from "../api";
import { TOKEN_ANSWERS } from "../../server/handlers";
import { FakeRoom } from "./voice-fakes";
import { fakeFetch, ok, refused } from "./fakes";

// US-0071 (A1b Task 15): the page's LiveKit connection behind the BrowserRoom seam. Every order that matters (microphone off before the
// mute is posted, the room left before the opt-out) is asserted on one shared call log.

beforeEach(() => FakeRoom.reset());

const TOKEN: TokenAnswer = { ok: true, token: "tok-1", url: "ws://127.0.0.1:7880" };

function make(o: { token?: () => TokenAnswer; post?: (muted: boolean) => ActionResult } = {}) {
  const log: string[] = [];
  let tokens = 0;
  const changes = vi.fn();
  const client = new VoiceClient({
    room: async () => new FakeRoom(log),
    fetchToken: async () => { tokens++; log.push("token"); return o.token ? o.token() : { ...TOKEN, token: `tok-${tokens}` }; },
    postMute: async (muted) => { log.push(`post mute ${muted}`); return o.post ? o.post(muted) : { ok: true }; },
    onChange: changes,
  });
  return { client, log, changes, tokens: () => tokens, room: () => FakeRoom.made.at(-1)! };
}

describe("VoiceClient", () => {
  it("join fetches the token, connects with url and token, then enables the microphone", async () => {
    const m = make();
    expect(m.client.state).toBe("idle");
    expect(await m.client.join()).toEqual({ ok: true });
    expect(m.log).toEqual(["token", "connect ws://127.0.0.1:7880 tok-1", "enable"]);
    expect(m.client.state).toBe("live");
    expect(m.room().published).toBe(true);
    expect(m.changes).toHaveBeenCalled();
    // The token is never kept: nothing on the client holds it after the call.
    expect(JSON.stringify(m.client)).not.toContain("tok-1");
  });

  it("a connect failure is failed with the fixed sentence and does not retry", async () => {
    const log: string[] = [];
    let rooms = 0;
    const client = new VoiceClient({
      room: async () => { rooms++; const r = new FakeRoom(log); r.failConnect = true; return r; },
      fetchToken: async () => TOKEN, postMute: async () => ({ ok: true }),
    });
    expect(await client.join()).toEqual({ ok: false, message: MESSAGES.voiceCouldNotConnect });
    expect(client.state).toBe("failed");
    expect(client.message).toBe(MESSAGES.voiceCouldNotConnect);
    expect(rooms).toBe(1);
    expect(log.filter((c) => c.startsWith("connect"))).toHaveLength(1);
    expect(log.at(-1)).toBe("disconnect");
    // The person may press Join again: one more attempt, by hand.
    await client.join();
    expect(rooms).toBe(2);
  });

  it("a voice_off answer gives the voice-off sentence and Join is not offered again", async () => {
    const m = make({ token: () => ({ ok: false, code: "voice_off", message: TOKEN_ANSWERS.voice_off.message }) });
    expect(await m.client.join()).toEqual({ ok: false, message: MESSAGES.voiceOffSession });
    expect(MESSAGES.voiceOffSession).toBe(TOKEN_ANSWERS.voice_off.message);
    expect(m.client.voiceOff).toBe(true);
    await m.client.join();
    expect(m.tokens()).toBe(1);
    expect(FakeRoom.made).toHaveLength(0);
  });

  it("another token refusal shows the BFF's sentence; an empty one the fixed sentence", async () => {
    const m = make({ token: () => ({ ok: false, code: "voice_refused", message: TOKEN_ANSWERS.voice_refused.message }) });
    expect(await m.client.join()).toEqual({ ok: false, message: TOKEN_ANSWERS.voice_refused.message });
    expect(m.client.voiceOff).toBe(false);
    const n = make({ token: () => ({ ok: false, code: "network", message: "" }) });
    expect(await n.client.join()).toEqual({ ok: false, message: MESSAGES.voiceCouldNotConnect });
  });

  it("a denied microphone at join gives the denied sentence and leaves the room", async () => {
    const log: string[] = [];
    const client = new VoiceClient({
      room: async () => { const r = new FakeRoom(log); r.failEnable = Object.assign(new Error("x"), { name: "NotAllowedError" }); return r; },
      fetchToken: async () => TOKEN, postMute: async () => ({ ok: true }),
    });
    expect(await client.join()).toEqual({ ok: false, message: MESSAGES.micDenied });
    expect(log.at(-1)).toBe("disconnect");
  });

  it("mute disables the microphone before posting", async () => {
    const m = make();
    await m.client.join();
    m.log.length = 0;
    expect(await m.client.mute()).toEqual({ ok: true });
    expect(m.log).toEqual(["disable", "post mute true"]);
    expect(m.client.state).toBe("muted");
    expect(m.room().published).toBe(false);
  });

  it("a microphone that cannot be turned off leaves the room (publishing must stop)", async () => {
    const m = make();
    await m.client.join();
    m.room().failDisable = true;
    m.log.length = 0;
    const r = await m.client.mute();
    expect(r.ok).toBe(false);
    expect(m.log).toEqual(["disable", "disconnect"]);
    expect(m.room().connected).toBe(false);
    expect(m.client.state).toBe("failed");
  });

  it("unmute posts before enabling; a refused unmute keeps the microphone off", async () => {
    let allow = false;
    const m = make({ post: (muted) => (muted || allow ? { ok: true } : { ok: false, message: "no" }) });
    await m.client.join();
    await m.client.mute();
    m.log.length = 0;
    expect(await m.client.unmute()).toEqual({ ok: false, message: "no" });
    expect(m.log).toEqual(["post mute false"]);
    expect(m.client.state).toBe("muted");
    expect(m.room().published).toBe(false);
    allow = true;
    m.log.length = 0;
    expect(await m.client.unmute()).toEqual({ ok: true });
    expect(m.log).toEqual(["post mute false", "enable"]);
    expect(m.client.state).toBe("live");
  });

  it("a failed mute post keeps the microphone off and reports the error", async () => {
    const m = make({ post: () => ({ ok: false, message: "Your choice was not confirmed. Reload the page to see it." }) });
    await m.client.join();
    expect(await m.client.mute()).toEqual({ ok: false, message: "Your choice was not confirmed. Reload the page to see it." });
    expect(m.client.state).toBe("muted");
    expect(m.room().published).toBe(false);
  });

  it("leave disconnects and is idempotent", async () => {
    const m = make();
    await m.client.join();
    await m.client.leave();
    await m.client.leave();
    expect(m.log.filter((c) => c === "disconnect")).toHaveLength(1);
    expect(m.client.state).toBe("idle");
    expect(m.room().connected).toBe(false);
    // A leave with nothing connected is a no-op too.
    const n = make();
    await n.client.leave();
    expect(n.log).toEqual([]);
  });

  it("a leave during the join wins: the room that connects late is left at once", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const client = new VoiceClient({
      room: async () => new FakeRoom(log),
      fetchToken: () => new Promise<TokenAnswer>((r) => { release = () => r(TOKEN); }),
      postMute: async () => ({ ok: true }),
    });
    const joining = client.join();
    expect(client.state).toBe("connecting");
    await client.leave();
    release();
    await joining;
    expect(client.state).toBe("idle");
    expect(FakeRoom.made.every((r) => !r.connected)).toBe(true);
  });

  it("a room disconnect moves to failed with the sentence; the client's own leave does not", async () => {
    const m = make();
    await m.client.join();
    m.room().serverDrop();
    expect(m.client.state).toBe("failed");
    expect(m.client.message).toBe(MESSAGES.voiceCouldNotConnect);
    const n = make();
    await n.client.join();
    await n.client.leave();
    expect(n.client.state).toBe("idle");
    expect(n.client.message).toBeNull();
  });

  it("rejoined after live fetches a new token and reconnects once", async () => {
    const m = make();
    await m.client.join();
    m.log.length = 0;
    await m.client.rejoined();
    expect(m.log).toEqual(["disconnect", "token", "connect ws://127.0.0.1:7880 tok-2", "enable"]);
    expect(m.client.state).toBe("live");
    expect(FakeRoom.made).toHaveLength(2);
  });

  it("a dropped runtime stream leaves the room; the fresh joined then reconnects with a new token", async () => {
    const m = make();
    await m.client.join();
    await m.client.dropped();
    expect(m.room().connected).toBe(false);
    expect(m.client.state).toBe("suspended");
    m.log.length = 0;
    await m.client.rejoined();
    expect(m.log).toEqual(["token", "connect ws://127.0.0.1:7880 tok-2", "enable"]);
    expect(m.client.state).toBe("live");
  });

  it("a failed reconnect is failed with no second attempt", async () => {
    let n = 0;
    const m = make({ token: () => (++n === 1 ? TOKEN : { ok: false, code: "voice_unavailable", message: TOKEN_ANSWERS.voice_unavailable.message }) });
    await m.client.join();
    await m.client.rejoined();
    expect(m.client.state).toBe("failed");
    expect(m.client.message).toBe(TOKEN_ANSWERS.voice_unavailable.message);
    expect(m.tokens()).toBe(2);
    await m.client.rejoined(); // failed is not live: nothing more
    expect(m.tokens()).toBe(2);
  });

  it("rejoined after muted re-posts the mute and does not publish", async () => {
    const m = make();
    await m.client.join();
    await m.client.mute();
    await m.client.dropped();
    m.log.length = 0;
    await m.client.rejoined();
    expect(m.log).toEqual(["token", "connect ws://127.0.0.1:7880 tok-2", "post mute true"]);
    expect(m.client.state).toBe("muted");
    expect(m.room().published).toBe(false);
    // Every fresh joined re-posts the mute (the runtime forgets it with the released holder), also without a drop first.
    m.log.length = 0;
    await m.client.rejoined();
    expect(m.log.filter((c) => c === "post mute true")).toHaveLength(1);
  });

  it("rejoined when idle or failed does nothing", async () => {
    const m = make();
    await m.client.rejoined();
    expect(m.log).toEqual([]);
    await m.client.dropped();
    expect(m.client.state).toBe("idle");
  });

  it("onChange is not called after the listener throws (a broken renderer cannot break the connection)", async () => {
    const client = new VoiceClient({ room: async () => new FakeRoom(), fetchToken: async () => TOKEN, postMute: async () => ({ ok: true }), onChange: () => { throw new Error("render"); } });
    expect(await client.join()).toEqual({ ok: true });
  });
});

describe("tokenFetcher", () => {
  it("posts no body to the token route and returns only the token and url", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({ token: "a.b.c", url: "wss://lk.example:7443", expiresAt: 5 }) }));
    expect(await tokenFetcher(f.fetch)()).toEqual({ ok: true, token: "a.b.c", url: "wss://lk.example:7443" });
    expect(f.calls[0]!.url).toBe("/api/v1/voice/token");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.body).toBeUndefined();
    expect(new Headers(f.calls[0]!.init.headers).get("X-Requested-With")).toBe("scenecoach");
  });

  it("a refusal keeps the code and the BFF's sentence; a malformed answer is the fixed sentence", async () => {
    const f = fakeFetch(() => ({ status: 409, body: refused("voice_off", TOKEN_ANSWERS.voice_off.message) }));
    expect(await tokenFetcher(f.fetch)()).toEqual({ ok: false, code: "voice_off", message: TOKEN_ANSWERS.voice_off.message });
    const g = fakeFetch(() => ({ status: 200, body: ok({ token: 5, url: "x" }) }));
    expect(await tokenFetcher(g.fetch)()).toEqual({ ok: false, code: "malformed", message: MESSAGES.voiceCouldNotConnect });
    const h = fakeFetch(() => ({ status: 200, body: ok({ token: "a.b.c", url: "http://not-a-socket" }) }));
    expect((await tokenFetcher(h.fetch)()).ok).toBe(false);
  });
});
