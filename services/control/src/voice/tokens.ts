import { createHmac } from "node:crypto";
import { isSafeId } from "@acr/events";
import { WORKER_IDENTITY_PREFIX, participantIdentity, workerIdentity, type MintInput, type MintedToken, type RoomAdmin } from "@acr/adapters/livekit";
import { isVoiceRoomName } from "@acr/speech/protocol";
import type { SetTimer } from "../supervisor.js";
import type { LiveKitConfig } from "./livekit-config.js";

/** How long a token request waits for the seats that make the caller a voice holder (the request after a reload can beat them). */
export const SEATS_WAIT_MS = 1000;

export type VoiceTokenCode = "voice_refused" | "voice_off" | "voice_unavailable";
/** A token (or a worker join) is refused. The message is fixed: never a room, an identity or a participant id. */
export class VoiceTokenRefused extends Error {
  constructor(readonly code: VoiceTokenCode) { super(`voice token refused (${code})`); this.name = "VoiceTokenRefused"; }
}

/** The runtime's `voice_seats`, as far as tokens care. */
export type TokenSeats = {
  paused: boolean; ended: boolean;
  holders: readonly { roleId: string; participantId: string; recording: boolean; voiceChosen: boolean }[];
  open: readonly string[];
};

type Waiter = { participantId: string; settle: (r: { ok: true } | { ok: false; code: VoiceTokenCode }) => void };
type Sweep = { running: boolean; pending: boolean };
type Session = {
  key: Buffer;
  /** roleId -> the seat's room ("v" + 32 hex), created on the first token or worker join for that seat. */
  rooms: Map<string, string>;
  seats?: TokenSeats;
  off: boolean;
  /**
   * Roles whose seat was reissued (or removed) and that nobody has bound since: no identity is expected for them, even when a report
   * shows them open (a whole-session reissue relaunches the runtime, whose first report shows every seat open). Cleared per role by
   * the first report that lists a holder for it.
   */
  reissued: Set<string>;
  /** One waiting token request per role. */
  waiters: Map<string, Waiter>;
  sweeps: Map<string, Sweep>;
};
/** The identity a seat room may hold: exactly one, none, or (an open seat: its holder may come back) whatever is there. */
type Expected = { kind: "one"; identity: string } | { kind: "none" } | { kind: "keep" };

const errorName = (err: unknown): string => (err instanceof Error && isSafeId(err.name) ? err.name : "Error");

/**
 * US-0071 (EPIC-0003 voice A1b, Task 5, K9, R6, R7): the LiveKit side of each voice session, in control memory only.
 *  - **One room per seat** ("v" + 32 random hex per session and human role), so a participant's connection shows them nothing of
 *    another seat. Rooms and the session key survive a runtime restart (openSession keeps them) and are lost with control (by design).
 *  - **Seat generation** = the first 8 hex of HMAC-SHA256(session key, roleId + "\n" + participantId): new for a reissue, a rebind and a
 *    control restart, the same across a page reload, and it leaks nothing of the participant id.
 *  - **Tokens** only for the current holder whose choice is voice (`voiceChosen`), for that seat's room; a caller not listed yet waits up
 *    to SEATS_WAIT_MS for the next seats (one waiter per seat). Not refused while paused or before the start (K1).
 *  - **Removal**: on every seat change each seat room is swept (`listParticipants`, then `removeParticipant` for every identity other
 *    than the expected one, never the worker's). Expected: the holder's identity when they chose voice; nothing after a leave,
 *    withdrawal, reissue, removal, AI fill or opt-out; anything for an open seat (a socket close: the same person may come back). A
 *    removed browser that reconnects with its still-valid token is removed again by the next sweep. Sweeps are serialised per room and
 *    coalesced (one in flight, one pending). `endSession` deletes every seat room.
 * Admin failures are logged by error name only and never thrown. Nothing here logs a room, an identity, a participant id or a token.
 */
export class VoiceTokens {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly o: {
    cfg: LiveKitConfig; admin: RoomAdmin;
    mint: (m: MintInput) => Promise<MintedToken>; mintWorker: (m: MintInput) => Promise<MintedToken>;
    random: (n: number) => Buffer; setTimer: SetTimer; log: (m: string) => void;
  }) {}

  /** A voice runtime attached (create, resume or a runtime restart). Idempotent: an existing session keeps its key and rooms. */
  openSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { key: this.o.random(32), rooms: new Map(), off: false, reissued: new Set(), waiters: new Map(), sweeps: new Map() });
  }

  /** The seat's room, created on first use. Throws RangeError for an unknown session. */
  roomOf(sessionId: string, roleId: string): string {
    const s = this.need(sessionId);
    let room = s.rooms.get(roleId);
    if (room === undefined) {
      room = `v${this.o.random(16).toString("hex")}`;
      if (!isVoiceRoomName(room)) throw new RangeError("roomOf: the random source gave too few bytes");
      s.rooms.set(roleId, room);
    }
    return room;
  }

  /** The seat generation of `participantId` holding `roleId`. Throws RangeError for an unknown session. */
  generation(sessionId: string, roleId: string, participantId: string): string {
    return createHmac("sha256", this.need(sessionId).key).update(`${roleId}\n${participantId}`).digest("hex").slice(0, 8);
  }

  /** A microphone-only token for the caller's own seat room. Rejects VoiceTokenRefused. */
  async issue(sessionId: string, roleId: string, participantId: string): Promise<MintedToken> {
    const s = this.sessions.get(sessionId);
    if (!s || s.seats?.ended) throw new VoiceTokenRefused("voice_unavailable");
    if (s.off) throw new VoiceTokenRefused("voice_off");
    if (!this.isVoiceHolder(s, roleId, participantId)) {
      if (s.waiters.has(roleId)) throw new VoiceTokenRefused("voice_refused");
      const r = await new Promise<{ ok: true } | { ok: false; code: VoiceTokenCode }>((resolve) => {
        const cancel = this.o.setTimer(() => { if (s.waiters.get(roleId) === w) { s.waiters.delete(roleId); resolve({ ok: false, code: "voice_refused" }); } }, SEATS_WAIT_MS);
        const w: Waiter = { participantId, settle: (x) => { cancel(); s.waiters.delete(roleId); resolve(x); } };
        s.waiters.set(roleId, w);
      });
      if (!r.ok) throw new VoiceTokenRefused(r.code);
    }
    const identity = participantIdentity(roleId, this.generation(sessionId, roleId, participantId));
    const room = this.roomOf(sessionId, roleId);
    try { return await this.o.mint({ apiKey: this.o.cfg.apiKey, apiSecret: this.o.cfg.apiSecret, room, identity }); }
    catch (err) {
      this.o.log(`session ${sessionId} voice token could not be minted (${errorName(err)})`);
      throw new VoiceTokenRefused("voice_unavailable");
    }
  }

  /** A fresh hidden, subscribe-only worker token for a RECORDING seat's room (each connect asks again). Rejects VoiceTokenRefused. */
  async workerJoin(sessionId: string, roleId: string): Promise<{ url: string; token: string; room: string }> {
    const s = this.sessions.get(sessionId);
    if (!s || s.seats?.ended) throw new VoiceTokenRefused("voice_unavailable");
    if (s.off) throw new VoiceTokenRefused("voice_off");
    const seats = s.seats;
    if (!seats || seats.paused || !seats.holders.some((h) => h.roleId === roleId && h.recording)) throw new VoiceTokenRefused("voice_refused");
    const room = this.roomOf(sessionId, roleId);
    const identity = workerIdentity(this.o.random(4).toString("hex"));
    const t = await this.o.mintWorker({ apiKey: this.o.cfg.apiKey, apiSecret: this.o.cfg.apiSecret, room, identity });
    return { url: this.o.cfg.workerUrl, token: t.token, room };
  }

  /** The runtime reported its seats: store them, answer waiting requests, sweep every seat room. Never throws. */
  seatsChanged(sessionId: string, next: TokenSeats): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.seats = next;
    for (const roleId of [...s.reissued]) if (next.holders.some((h) => h.roleId === roleId)) s.reissued.delete(roleId);
    for (const [roleId, w] of [...s.waiters]) {
      if (next.ended) w.settle({ ok: false, code: "voice_unavailable" });
      else if (this.isVoiceHolder(s, roleId, w.participantId)) w.settle({ ok: true });
    }
    for (const roleId of s.rooms.keys()) this.sweep(sessionId, s, roleId);
  }

  /** The session's runtime exited: its seats are gone with it (no sweep: the next runtime's seats decide). */
  runtimeExited(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) delete s.seats;
  }

  /** A code reissue (or a removal) gave the seat to someone new: its identity goes at once, before the next seats report. */
  roleReissued(sessionId: string, roleId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.reissued.add(roleId);
    if (s.rooms.has(roleId)) this.sweep(sessionId, s, roleId);
  }

  /** Voice is off for the session after repeated faults (Task 8): no token from now on, every seat identity goes. */
  voiceOff(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.off = true;
    for (const w of [...s.waiters.values()]) w.settle({ ok: false, code: "voice_off" });
    for (const roleId of s.rooms.keys()) this.sweep(sessionId, s, roleId);
  }

  /** The session ended: every seat room is deleted and the session forgotten. Never throws. */
  endSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    for (const w of [...s.waiters.values()]) w.settle({ ok: false, code: "voice_unavailable" });
    for (const room of s.rooms.values()) {
      this.o.admin.deleteRoom(room).catch((err: unknown) => this.o.log(`session ${sessionId} voice room delete failed (${errorName(err)})`));
    }
  }

  private need(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RangeError("unknown voice session");
    return s;
  }

  private isVoiceHolder(s: Session, roleId: string, participantId: string): boolean {
    return !!s.seats && !s.seats.ended && s.seats.holders.some((h) => h.roleId === roleId && h.participantId === participantId && h.voiceChosen);
  }

  private expected(sessionId: string, s: Session, roleId: string): Expected {
    if (s.off || s.reissued.has(roleId)) return { kind: "none" };
    const seats = s.seats;
    if (!seats) return { kind: "keep" }; // no runtime report (a runtime restart): nothing is known, nothing is removed
    const h = seats.holders.find((x) => x.roleId === roleId);
    if (h?.voiceChosen) return { kind: "one", identity: participantIdentity(roleId, this.generation(sessionId, roleId, h.participantId)) };
    if (!h && seats.open.includes(roleId)) return { kind: "keep" };
    return { kind: "none" };
  }

  /** Serialised per room and coalesced: one sweep in flight; changes meanwhile make ONE more run with the state as it then is. */
  private sweep(sessionId: string, s: Session, roleId: string): void {
    const room = s.rooms.get(roleId);
    if (room === undefined) return;
    let st = s.sweeps.get(room);
    if (!st) { st = { running: false, pending: false }; s.sweeps.set(room, st); }
    if (st.running) { st.pending = true; return; }
    st.running = true;
    const state = st;
    const run = async (): Promise<void> => {
      do {
        state.pending = false;
        try { await this.sweepOnce(sessionId, s, roleId, room); }
        catch (err) { this.o.log(`session ${sessionId} voice participant sweep failed (${errorName(err)})`); }
      } while (state.pending && this.sessions.get(sessionId) === s);
      state.running = false;
    };
    void run();
  }

  private async sweepOnce(sessionId: string, s: Session, roleId: string, room: string): Promise<void> {
    if (this.expected(sessionId, s, roleId).kind === "keep") return;
    const present = await this.o.admin.listParticipants(room);
    const want = this.expected(sessionId, s, roleId); // the state may have moved on while the list was in flight
    if (want.kind === "keep") return;
    for (const identity of present) {
      if (identity.startsWith(WORKER_IDENTITY_PREFIX)) continue;
      if (want.kind === "one" && identity === want.identity) continue;
      await this.o.admin.removeParticipant(room, identity);
    }
  }
}
