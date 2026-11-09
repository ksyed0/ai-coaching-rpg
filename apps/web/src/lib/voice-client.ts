import { postJson, type ActionResult } from "./api";
import { MESSAGES } from "./messages";

// US-0071 (A1b Task 15): the participant page's LiveKit connection, behind the BrowserRoom seam (livekit-room-browser.ts is the only
// file that imports livekit-client, and it is loaded by a dynamic import on the first "Join with voice"). Tests run this class against a
// fake room: no LiveKit server, no microphone.
//
// Rules this class keeps:
// - The token is fetched for every connect (a join, a reconnect) and passed straight to `connect`: it is never stored, logged or shown.
// - No retry loop: a failed join or reconnect is `failed` with a fixed sentence; the person may press "Join with voice" again.
// - Mute turns the microphone off FIRST (the wrapper unpublishes the track), then tells the runtime; unmute tells the runtime first.
//   A microphone that cannot be turned off leaves the room: publishing must stop either way.
// - `dropped` (the runtime stream fell away) leaves the room; `rejoined` (a fresh `joined`) reconnects ONCE with a fresh token when the
//   page was connected, and re-posts the local mute (the runtime forgets a mute when the holder is released).

/** What VoiceClient needs from a LiveKit room. `disableMicrophone` must really stop publishing (it unpublishes the track). */
export interface BrowserRoom {
  connect(url: string, token: string): Promise<void>;
  enableMicrophone(): Promise<void>;
  disableMicrophone(): Promise<void>;
  disconnect(): Promise<void>;
  onDisconnected(fn: () => void): void;
}

export type TokenAnswer = { ok: true; token: string; url: string } | { ok: false; code: string; message: string };

/**
 * idle: not connected. connecting: a join is under way. live: publishing the microphone. muted: connected, nothing published.
 * suspended: left because the runtime stream dropped; the next fresh `joined` reconnects. failed: a join, a reconnect or the room failed.
 */
export type VoiceClientState = "idle" | "connecting" | "live" | "muted" | "suspended" | "failed";

export type VoiceClientOptions = {
  /** A new room for each connect (the factory may load livekit-client on first use). */
  room: () => Promise<BrowserRoom>;
  fetchToken: () => Promise<TokenAnswer>;
  postMute: (muted: boolean) => Promise<ActionResult>;
  onChange?: () => void;
};

const isDenied = (err: unknown): boolean => err instanceof Error && (err.name === "NotAllowedError" || err.name === "SecurityError");

export class VoiceClient {
  #state: VoiceClientState = "idle";
  #message: string | null = null;
  #voiceOff = false;
  #room: BrowserRoom | null = null;
  /** Bumped by every leave, drop and reconnect: an older connect that resolves late leaves its room at once. */
  #gen = 0;
  /** Whether the connection that `dropped` ended was muted (a reconnect restores it). */
  #resumeMuted = false;
  #version = 0;
  readonly #listeners = new Set<() => void>();
  readonly #o: VoiceClientOptions;

  constructor(o: VoiceClientOptions) {
    this.#o = o;
    if (o.onChange) this.#listeners.add(o.onChange);
  }

  get state(): VoiceClientState { return this.#state; }
  /** The fixed sentence of the last failure (null otherwise). */
  get message(): string | null { return this.#message; }
  /** Voice is off for this session (the token route said so): "Join with voice" is not offered again. */
  get voiceOff(): boolean { return this.#voiceOff; }
  /** Counts changes (for useSyncExternalStore). */
  get version(): number { return this.#version; }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Fetches a token, connects, then publishes the microphone. */
  async join(): Promise<ActionResult> {
    if (this.#voiceOff) return { ok: false, message: MESSAGES.voiceOffSession };
    if (this.#state === "connecting" || this.#state === "live" || this.#state === "muted") return { ok: true };
    return this.#connect(false);
  }

  /** The microphone off first (unpublished), then the runtime told. A failed post keeps the microphone off. */
  async mute(): Promise<ActionResult> {
    const room = this.#room;
    if (this.#state !== "live" || room === null) return { ok: true };
    try { await room.disableMicrophone(); }
    catch {
      await this.#fail(MESSAGES.voiceCouldNotConnect);
      return { ok: false, message: MESSAGES.voiceCouldNotConnect };
    }
    if (this.#room !== room) return { ok: true };
    this.#set("muted");
    return this.#o.postMute(true);
  }

  /** The runtime told first; only then the microphone on. Also from `live` when the runtime holds the seat muted. */
  async unmute(): Promise<ActionResult> {
    const room = this.#room;
    if ((this.#state !== "muted" && this.#state !== "live") || room === null) return { ok: true };
    const r = await this.#o.postMute(false);
    if (!r.ok || this.#room !== room) return r;
    try { await room.enableMicrophone(); }
    catch (err) {
      const message = isDenied(err) ? MESSAGES.micDenied : MESSAGES.voiceCouldNotConnect;
      await this.#fail(message);
      return { ok: false, message };
    }
    if (this.#room === room) this.#set("live");
    return { ok: true };
  }

  /** Leaves the room; idempotent. */
  async leave(): Promise<void> {
    this.#gen++;
    this.#message = null;
    const room = this.#room;
    this.#room = null;
    if (this.#state !== "idle") this.#set("idle");
    await this.#quietly(room);
  }

  /** The runtime stream dropped: leave the room now (a crashed control's room would keep us publishing), reconnect on `rejoined`. */
  async dropped(): Promise<void> {
    if (this.#state !== "live" && this.#state !== "muted" && this.#state !== "connecting") return;
    this.#resumeMuted = this.#state === "muted";
    this.#gen++;
    const room = this.#room;
    this.#room = null;
    this.#set("suspended");
    await this.#quietly(room);
  }

  /** A fresh `joined` arrived: reconnect ONCE with a fresh token if the page was connected; re-post a local mute. */
  async rejoined(): Promise<void> {
    if (this.#state !== "live" && this.#state !== "muted" && this.#state !== "suspended") return;
    const muted = this.#state === "muted" || (this.#state === "suspended" && this.#resumeMuted);
    this.#gen++;
    const room = this.#room;
    this.#room = null;
    await this.#quietly(room);
    await this.#connect(muted);
  }

  async #connect(muted: boolean): Promise<ActionResult> {
    const gen = ++this.#gen;
    this.#message = null;
    this.#set("connecting");
    const t = await this.#o.fetchToken();
    if (gen !== this.#gen) return { ok: false, message: "" };
    if (!t.ok) {
      if (t.code === "voice_off") this.#voiceOff = true;
      const message = t.code === "voice_off" ? MESSAGES.voiceOffSession : t.message || MESSAGES.voiceCouldNotConnect;
      this.#failNow(message);
      return { ok: false, message };
    }
    let room: BrowserRoom;
    try { room = await this.#o.room(); }
    catch {
      if (gen === this.#gen) this.#failNow(MESSAGES.voiceCouldNotConnect);
      return { ok: false, message: MESSAGES.voiceCouldNotConnect };
    }
    if (gen !== this.#gen) return { ok: false, message: "" };
    this.#room = room;
    room.onDisconnected(() => {
      // Only a drop of the current room counts: our own leave and reconnects clear #room first.
      if (this.#room === room) { this.#room = null; this.#failNow(MESSAGES.voiceCouldNotConnect); }
    });
    try {
      await room.connect(t.url, t.token);
      if (gen !== this.#gen) { await this.#quietly(room); return { ok: false, message: "" }; }
      if (!muted) await room.enableMicrophone();
    } catch (err) {
      if (gen !== this.#gen) return { ok: false, message: "" };
      const message = isDenied(err) ? MESSAGES.micDenied : MESSAGES.voiceCouldNotConnect;
      await this.#fail(message);
      return { ok: false, message };
    }
    if (gen !== this.#gen) { await this.#quietly(room); return { ok: false, message: "" }; }
    this.#set(muted ? "muted" : "live");
    if (muted) return this.#o.postMute(true);
    return { ok: true };
  }

  /** Leaves the room and shows `message`; no retry. */
  async #fail(message: string): Promise<void> {
    this.#gen++;
    const room = this.#room;
    this.#room = null;
    this.#failNow(message);
    await this.#quietly(room);
  }

  #failNow(message: string): void {
    this.#message = message;
    this.#set("failed");
  }

  async #quietly(room: BrowserRoom | null): Promise<void> {
    if (room === null) return;
    try { await room.disconnect(); } catch { /* the room is gone either way */ }
  }

  #set(s: VoiceClientState): void {
    this.#state = s;
    this.#version++;
    for (const fn of [...this.#listeners]) {
      try { fn(); } catch { /* a listener's fault never breaks the connection */ }
    }
  }
}

/** A JWT's shape: three non-empty dot-separated parts of printable characters (the BFF checked the base64url alphabet already). */
const isJwtShape = (t: string): boolean => t.length <= 4096 && !/[^\x21-\x7e]/.test(t) && t.split(".").length === 3 && t.split(".").every((p) => p.length > 0);
const isSocketOrigin = (u: string): boolean => {
  try { const p = new URL(u); return (p.protocol === "wss:" || p.protocol === "ws:") && p.origin === u; } catch { return false; }
};

/** POST /api/v1/voice/token (no body): only `token` and `url` are taken from the answer, checked for shape. */
export function tokenFetcher(fetchImpl: typeof fetch): () => Promise<TokenAnswer> {
  return async () => {
    const r = await postJson("/api/v1/voice/token", undefined, fetchImpl);
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    const d = r.data as { token?: unknown; url?: unknown } | null;
    if (typeof d?.token !== "string" || !isJwtShape(d.token) || typeof d.url !== "string" || !isSocketOrigin(d.url)) {
      return { ok: false, code: "malformed", message: MESSAGES.voiceCouldNotConnect };
    }
    return { ok: true, token: d.token, url: d.url };
  };
}
