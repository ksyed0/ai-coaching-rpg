import { randomUUID } from "node:crypto";
import { consoleActivity } from "./activity-copy";
import { consoleCharacters, isRecord, strings, consoleEvent, consoleFactTexts, consoleRoster, consoleScenes, consoleState, wellFormedHiddenFacts, type ConsoleFactText } from "./facilitator-copies";
import type { FacilitatorJoin } from "./facilitator-socket";
import { LauncherError, type LauncherClient } from "./launcher-client";
import type { RuntimeConnection, SetTimer } from "./runtime-connection";
import { DEFAULT_MAX_PENDING_BYTES, heartbeat, replayIncomplete, RETRY_MS, sseFrame as sse, SseWriter, type SseOut } from "./sse";
import type { CommandMessage, ServerMessage } from "./wire";
import type { SessionState } from "@acr/events";

// Bridges one facilitator runtime socket to one server-sent-events response. The console cookie is checked by the route; US-0083: each
// stream also remembers WHICH account opened it ({accountId, epoch}; both null for a legacy sign-in) and every heartbeat re-checks it
// with the control service, so a revoked, reset or password-changed account's open stream ends within one heartbeat (closeAccount ends
// it at once). Any number of tabs may watch one session. It never reconnects (the browser's EventSource does).
// Only constants are written as event names, and only copies from facilitator-copies.ts as data. Utterances, Game Master reasoning and
// whispers do reach the page, by design (the facilitator sees them); NPC secrets, participant ids and runtime error text do not.

export const MAX_FACILITATOR_STREAMS = 64;
/** How long a command waits for the runtime's answer before it is reported unconfirmed. */
export const COMMAND_TIMEOUT_MS = 10_000;
/** The result of one command sent over a tab's own runtime socket. */
export type CommandOutcome = { kind: "ok" } | { kind: "refused"; code: string } | { kind: "unconfirmed" } | { kind: "no_channel" } | { kind: "pending" };
/** Refusals the runtime sends without a ref (before it has parsed one); while a command is pending they answer it. */
const REFLESS_ANSWERS = new Set(["rate_limited", "bad_json", "bad_message"]);
/** The route writes `stopped` and `busy` itself. */
export type ConsoleStreamFinal = "reconnecting" | "ended" | "expired";
/** The runtime's error codes are short snake_case words; anything else is not forwarded as a code. */
const CODE_SHAPE = /^[a-z_]{1,40}$/;
const ERROR_MESSAGE = "the server reported an error";

/** Each AI character's goals and released texts from a joined state; a malformed state counts as none. */
function joinedNpcs(state: unknown): Map<string, { goals: string[]; released: string[] }> {
  const out = new Map<string, { goals: string[]; released: string[] }>();
  const npcs = isRecord(state) ? state.npcs : undefined;
  if (!isRecord(npcs)) return out;
  for (const id of Object.keys(npcs)) {
    const r = isRecord(npcs[id]) ? (npcs[id] as Record<string, unknown>) : {};
    out.set(id, { goals: strings(r.goals), released: strings(r.released) });
  }
  return out;
}

/** Who opened a stream: an account and its epoch, or (both null) a legacy shared-secret sign-in. */
export type StreamOwner = { accountId: string | null; epoch: number | null };
/**
 * The heartbeat's re-check: "refused" (the sign-in no longer holds) ends the stream with `expired`; "gone" (the caller may no longer use
 * this session: another owner, or control no longer knows it) ends it with `reconnecting`, like closeSession, so the browser reconnects
 * and the route's ownership check answers; "unavailable" (control unreachable) keeps it and asks again next beat.
 */
export type RecheckResult = "ok" | "refused" | "gone" | "unavailable";
export type StreamRecheck = (who: StreamOwner, sessionId: string) => Promise<RecheckResult>;

/**
 * The re-check against the control service: requireConsole's rule (an account that must change its password is refused too) and the
 * stream route's ownership rule (an admin may use any session, a facilitator only its own; legacy acts as admin). It covers a stream that
 * was still joining when closeAccount or closeSession ran: its next heartbeat ends it.
 */
export function consoleRecheck(launcher: Pick<LauncherClient, "accountCheck" | "legacyAllowed" | "session">): StreamRecheck {
  return async (who, sessionId) => {
    try {
      if (who.accountId === null || who.epoch === null) return (await launcher.legacyAllowed()) ? "ok" : "refused";
      const a = await launcher.accountCheck(who.accountId, who.epoch);
      if (a === null || a.status === "revoked" || a.mustChange) return "refused";
      if (a.role === "admin") return "ok";
      let owner: string | undefined;
      try {
        owner = (await launcher.session(sessionId)).owner;
      } catch (err) {
        if (err instanceof LauncherError && err.reason === "not_found") return "gone";
        return "unavailable";
      }
      return owner === a.id ? "ok" : "gone";
    } catch {
      return "unavailable";
    }
  };
}

type Pending = { ref: string; type: CommandMessage["type"]; resolve: (o: CommandOutcome) => void; cancelTimer: () => void };
type Stream = { channel: string; sessionId: string; pending: Pending | null; expiresAt: number; owner: StreamOwner; checking: boolean; conn: RuntimeConnection; out: SseOut; writer: SseWriter; ended: boolean; skip: number;
  /** Hidden-fact text and each AI character's last goals and released texts. Memory only: fact text never leaves except through `factsFor`. */
  facts: ConsoleFactText[]; hidden: Record<string, string[]>; npcs: Map<string, { goals: string[]; released: string[] }>; cancelHeartbeat: () => void; detach: () => void };

export type FacilitatorHubOptions = {
  setTimer: SetTimer; now: () => number; maxStreams?: number; maxPendingBytes?: number; newChannelId?: () => string;
  commandTimeoutMs?: number; newRef?: () => string;
  /** US-0083: run at every heartbeat; absent, nothing is re-checked (single mode has no control service). */
  recheck?: StreamRecheck;
};

export class FacilitatorHub {
  private readonly streams = new Map<string, Stream>();
  private readonly maxStreams: number;
  private readonly maxPendingBytes: number;
  private readonly newChannelId: () => string;
  private readonly commandTimeoutMs: number;
  private readonly newRef: () => string;

  constructor(private readonly o: FacilitatorHubOptions) {
    this.maxStreams = o.maxStreams ?? MAX_FACILITATOR_STREAMS;
    this.maxPendingBytes = o.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.newChannelId = o.newChannelId ?? randomUUID;
    this.commandTimeoutMs = o.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.newRef = o.newRef ?? randomUUID;
  }

  size(): number { return this.streams.size; }

  /** Takes ownership of `conn` in every case: on "capacity" it is already closed and `out` ended with nothing written. */
  open(a: { sessionId: string; expiresAt: number; accountId: string | null; epoch: number | null; conn: RuntimeConnection; joined: FacilitatorJoin; out: SseOut }): { channel: string; close(): void } | "capacity" {
    const { conn, out, joined } = a;
    if (this.streams.size >= this.maxStreams) {
      conn.close();
      try { out.end(); } catch { /* the client is gone */ }
      return "capacity";
    }
    const channel = this.newChannelId();
    const s: Stream = { channel, sessionId: a.sessionId, pending: null, expiresAt: a.expiresAt, owner: { accountId: a.accountId, epoch: a.epoch }, checking: false, conn, out, writer: new SseWriter(out, this.maxPendingBytes), ended: false, skip: 0, facts: [], hidden: {}, npcs: new Map(), cancelHeartbeat: () => {}, detach: () => {} };
    this.streams.set(channel, s);
    s.writer.beginOpening();
    try {
      const frame = joined.frame;
      this.write(s, `retry: ${RETRY_MS}\n\n`);
      // Picked, never spread: `frame` is the runtime's whole object (hiddenFacts and notice included at runtime).
      s.facts = consoleFactTexts(wellFormedHiddenFacts(frame.hiddenFacts));
      s.hidden = Object.fromEntries(s.facts.map((f) => [f.roleId, f.facts.map((x) => x.text)]));
      s.npcs = joinedNpcs(frame.state);
      this.write(s, sse("joined", { channel, scenes: consoleScenes(frame.scenes) }));
      if (replayIncomplete(frame.replay)) {
        // The id moves Last-Event-ID to the snapshot; replayed events are already in it.
        const at = frame.state.lastSeq;
        this.write(s, sse("reset", { state: consoleState(frame.state as SessionState) }, Number.isSafeInteger(at) ? at : undefined));
        s.skip = frame.replay?.events ?? 0;
      }
      this.writeCharacters(s);
      this.write(s, sse("roster", { entries: consoleRoster(joined.roster) }));
    } catch {
      // A copy that throws must not leak the slot or the connection.
      this.finish(s, "reconnecting");
    }
    if (s.ended) return { channel, close: () => {} };
    s.cancelHeartbeat = heartbeat(this.o.setTimer, () => {
      if (s.expiresAt <= this.o.now()) { this.finish(s, "expired"); return false; }
      this.recheck(s);
      return this.write(s, ": hb\n\n");
    });
    const offFrame = conn.onFrame((m) => this.onFrame(s, m));
    // The first onFrame flushed the queued replay synchronously, still undrained: it is part of the opening (BUG-0024).
    s.writer.endOpening();
    const offClose = conn.onClose(() => this.finish(s, "reconnecting"));
    s.detach = () => { offFrame(); offClose(); };
    if (s.ended) s.detach();
    return { channel, close: () => this.finish(s, null) };
  }

  /**
   * US-0083: ends every open stream of this account at once (with `expired`), whatever its epoch. The BFF's revoke, reset and password
   * routes call it after control has answered. Returns how many streams it ended.
   */
  closeAccount(accountId: string): number {
    let n = 0;
    for (const s of [...this.streams.values()]) {
      if (s.owner.accountId === accountId) { this.finish(s, "expired"); n++; }
    }
    return n;
  }

  /**
   * US-0083: ends every open stream of this session at once, through the same finish path as closeAccount, with `reconnecting`: the
   * browser reconnects and the stream route's ownership check decides again (an admin and the new owner get a stream, a previous owner
   * the neutral 404). The owner route calls it after control recorded a change of owner. Returns how many streams it ended.
   */
  closeSession(sessionId: string): number {
    let n = 0;
    for (const s of [...this.streams.values()]) {
      if (s.sessionId === sessionId) { this.finish(s, "reconnecting"); n++; }
    }
    return n;
  }

  /** One re-check at a time per stream; a refusal ends it, anything else (control unreachable included) leaves it open. */
  private recheck(s: Stream): void {
    const check = this.o.recheck;
    if (!check || s.checking) return;
    s.checking = true;
    let pending: Promise<RecheckResult>;
    try { pending = check(s.owner, s.sessionId); } catch { s.checking = false; return; }
    pending.then(
      (r) => { s.checking = false; if (r === "refused") this.finish(s, "expired"); else if (r === "gone") this.finish(s, "reconnecting"); },
      () => { s.checking = false; },
    );
  }

  /** The hidden-fact text of this session's channel, or null: the channel is unknown, ended or another session's. */
  factsFor(sessionId: string, channel: string): ConsoleFactText[] | null {
    const s = this.streams.get(channel);
    if (!s || s.ended || s.sessionId !== sessionId) return null;
    return s.facts.map((f) => ({ roleId: f.roleId, facts: f.facts.map((x) => ({ n: x.n, text: x.text })) }));
  }

  private writeCharacters(s: Stream): void {
    this.write(s, sse("characters", { roles: consoleCharacters(s.hidden, Object.fromEntries(s.npcs)) }));
  }

  /**
   * Sends one command over the tab's own runtime socket and resolves with the runtime's answer. One command per channel at a time; never
   * retried. A channel that is unknown, belongs to another session or has finished is `no_channel`.
   */
  send(a: { sessionId: string; channel: string; message: CommandMessage }): Promise<CommandOutcome> {
    const s = this.streams.get(a.channel);
    if (!s || s.ended || s.sessionId !== a.sessionId) return Promise.resolve({ kind: "no_channel" });
    if (s.pending) return Promise.resolve({ kind: "pending" });
    const ref = this.newRef();
    return new Promise<CommandOutcome>((resolve) => {
      const p: Pending = { ref, type: a.message.type, resolve, cancelTimer: () => {} };
      s.pending = p;
      p.cancelTimer = this.o.setTimer(() => this.settle(s, p, { kind: "unconfirmed" }), this.commandTimeoutMs);
      try { s.conn.send({ ...a.message, ref }); } catch { this.settle(s, p, { kind: "unconfirmed" }); }
    });
  }

  private settle(s: Stream, p: Pending, outcome: CommandOutcome): void {
    if (s.pending !== p) return;
    s.pending = null;
    p.cancelTimer();
    p.resolve(outcome);
  }

  private onFrame(s: Stream, m: ServerMessage): void {
    try { this.forward(s, m); } catch { this.finish(s, "reconnecting"); }
  }

  private forward(s: Stream, m: ServerMessage): void {
    if (s.ended) return;
    if (m.type === "ack") { // never forwarded; answers the pending command only when the ref is its own
      if (s.pending && s.pending.ref === m.ref) this.settle(s, s.pending, { kind: "ok" });
      return;
    }
    if (m.type === "error" && m.ref !== undefined) {
      if (s.pending && s.pending.ref === m.ref) this.settle(s, s.pending, { kind: "refused", code: CODE_SHAPE.test(m.code) ? m.code : "error" });
      return;
    }
    if (m.type === "error" && s.pending && REFLESS_ANSWERS.has(m.code)) {
      this.settle(s, s.pending, { kind: "refused", code: m.code });
      return;
    }
    if (m.type === "event") {
      if (s.skip > 0) { s.skip--; return; }
      const seq = m.event.seq;
      if (!this.write(s, sse("event", consoleEvent(m.event), Number.isSafeInteger(seq) ? seq : undefined))) return;
      if (m.event.type === "npc.updated") {
        const e = m.event as unknown as Record<string, unknown>;
        if (typeof e.roleId === "string") {
          // `released` is optional on the event and the reducer keeps the previous list when it is absent.
          const released = Array.isArray(e.released) ? strings(e.released) : (s.npcs.get(e.roleId)?.released ?? []);
          s.npcs.set(e.roleId, { goals: strings(e.goals), released });
          this.writeCharacters(s);
        }
      }
      if (s.ended) return;
      if (m.event.type === "session.ended") {
        // end_now emits session.ended before its ack, and the stream ends here: the ended event is the confirmation.
        if (s.pending?.type === "end_now") this.settle(s, s.pending, { kind: "ok" });
        this.finish(s, "ended");
      }
    } else if (m.type === "roster") {
      if (m.audience === "facilitator") this.write(s, sse("roster", { entries: consoleRoster(m.entries) }));
    } else if (m.type === "error") {
      this.write(s, sse("error", { code: CODE_SHAPE.test(m.code) ? m.code : "error", message: ERROR_MESSAGE }));
    } else if (m.type === "activity") {
      // US-0082: who is composing a reply (with why a turn ended without its line), picked field by field; a malformed one is dropped.
      const a = consoleActivity(m);
      if (a) this.write(s, sse("activity", a));
    }
    // Anything else (another joined, an unknown type) is not forwarded.
  }

  private write(s: Stream, chunk: string): boolean {
    if (s.ended) return false;
    const r = s.writer.write(chunk);
    if (r === "gone") { this.finish(s, null); return false; }
    if (r === "stalled") { this.finish(s, "reconnecting"); return false; }
    return true;
  }

  private finish(s: Stream, event: ConsoleStreamFinal | null): void {
    if (s.ended) return;
    s.ended = true;
    s.facts = [];
    s.hidden = {};
    s.npcs = new Map();
    if (this.streams.get(s.channel) === s) this.streams.delete(s.channel);
    if (s.pending) this.settle(s, s.pending, { kind: "unconfirmed" });
    s.cancelHeartbeat();
    s.detach();
    if (event) { try { s.out.write(sse(event, {})); } catch { /* the client is gone */ } }
    try { s.out.end(); } catch { /* already closed by the client */ }
    s.conn.close();
  }
}
