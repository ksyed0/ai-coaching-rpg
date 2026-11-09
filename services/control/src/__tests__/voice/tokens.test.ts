import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LiveKitAdminError, parseParticipantIdentity, type RoomAdmin } from "@acr/adapters/livekit";
import { isVoiceRoomName } from "@acr/speech/protocol";
import type { LiveKitConfig } from "../../voice/livekit-config.js";
import { MAX_WAITERS_PER_ROLE, SEATS_WAIT_MS, SWEEP_INTERVAL_MS, SWEEP_RETRY_MS, VoiceTokenRefused, VoiceTokens, type TokenSeats } from "../../voice/tokens.js";

// US-0071 (EPIC-0003 voice A1b, Task 5, K9, R6, R7): one LiveKit room per seat, seat generations, the token rules and identity removal.
const S1 = "a".repeat(32);
const S2 = "b".repeat(32);
const CFG: LiveKitConfig = { apiKey: "APIkey", apiSecret: "s".repeat(40), host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" };

type Timer = { fn: () => void; ms: number; cancelled: boolean };
type Deferred = { resolve: () => void; reject: (e: unknown) => void };

/** A fake LiveKit server: rooms of identities. `hold` makes every list wait until released (for the serialisation test). */
class FakeAdmin implements RoomAdmin {
  rooms = new Map<string, Set<string>>();
  calls: string[] = [];
  failAll = false;
  hold = false;
  held: Deferred[] = [];
  deleted: string[] = [];
  join(room: string, identity: string): void { if (!this.rooms.has(room)) this.rooms.set(room, new Set()); this.rooms.get(room)!.add(identity); }
  in(room: string): string[] { return [...(this.rooms.get(room) ?? [])]; }
  async removeParticipant(room: string, identity: string): Promise<void> {
    this.calls.push(`remove ${room} ${identity}`);
    if (this.failAll) throw new LiveKitAdminError("remove", { status: 500 });
    this.rooms.get(room)?.delete(identity);
  }
  async listParticipants(room: string): Promise<string[]> {
    this.calls.push(`list ${room}`);
    if (this.hold) await new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
    if (this.failAll) throw new LiveKitAdminError("list", { status: 500 });
    return this.in(room);
  }
  async deleteRoom(room: string): Promise<void> {
    this.calls.push(`delete ${room}`);
    if (this.failAll) throw new LiveKitAdminError("delete", { status: 500 });
    this.deleted.push(room);
    this.rooms.delete(room);
  }
}

/** A deterministic `random`: a counter hashed (distinct bytes every call). */
function seeded(seed: string): (n: number) => Buffer {
  let i = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let off = 0; off < n; off += 32) createHash("sha256").update(`${seed}:${i++}`).digest().copy(out, off);
    return out;
  };
}

function harness(o: { random?: (n: number) => Buffer } = {}) {
  const admin = new FakeAdmin();
  const timers: Timer[] = [];
  const logs: string[] = [];
  const minted: { kind: "participant" | "worker"; room: string; identity: string; token: string }[] = [];
  let n = 0;
  const tokens = new VoiceTokens({
    cfg: CFG, admin, random: o.random ?? seeded("t"), log: (m) => logs.push(m),
    setTimer: (fn, ms) => { const t: Timer = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    mint: async (m) => { const token = `jwt-participant-${++n}`; minted.push({ kind: "participant", room: m.room, identity: m.identity, token }); return { token, expiresAt: 600_000 }; },
    mintWorker: async (m) => { const token = `jwt-worker-${++n}`; minted.push({ kind: "worker", room: m.room, identity: m.identity, token }); return { token, expiresAt: 600_000 }; },
  });
  const fire = (ms: number): void => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
  return { tokens, admin, timers, logs, minted, fire };
}

const holder = (roleId: string, participantId: string, o: { voiceChosen?: boolean; recording?: boolean } = {}) =>
  ({ roleId, participantId, recording: o.recording ?? (o.voiceChosen ?? true), voiceChosen: o.voiceChosen ?? true });
const seats = (holders: ReturnType<typeof holder>[], open: string[] = [], o: { paused?: boolean; ended?: boolean } = {}): TokenSeats =>
  ({ paused: o.paused ?? false, ended: o.ended ?? false, holders, open });
/** Lets every queued sweep step (fake admin promises) run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "resolved"; } catch (err) { return err instanceof VoiceTokenRefused ? err.code : `other:${(err as Error).name}`; }
};

describe("VoiceTokens: seat rooms and generations (US-0071, A1b Task 5)", () => {
  it("each seat has its own room, v plus 32 hex, different per role and per session, stable for the session", () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.openSession(S2);
    const a = h.tokens.roomOf(S1, "tech_lead");
    const b = h.tokens.roomOf(S1, "cfo");
    const c = h.tokens.roomOf(S2, "tech_lead");
    for (const r of [a, b, c]) expect(isVoiceRoomName(r)).toBe(true);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(h.tokens.roomOf(S1, "tech_lead")).toBe(a);
    h.tokens.openSession(S1); // a runtime restart re-attaches: the key and the rooms are kept
    expect(h.tokens.roomOf(S1, "tech_lead")).toBe(a);
  });

  it("the identity is role.g plus 8 hex and stays the same for the same participant; a new participant gets another generation", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await h.tokens.issue(S1, "tech_lead", "p1");
    await h.tokens.issue(S1, "tech_lead", "p1");
    const [x, y] = h.minted;
    expect(parseParticipantIdentity(x!.identity)).toEqual({ roleId: "tech_lead", generation: h.tokens.generation(S1, "tech_lead", "p1") });
    expect(y!.identity).toBe(x!.identity);
    expect(x!.room).toBe(h.tokens.roomOf(S1, "tech_lead"));
    expect(h.tokens.generation(S1, "tech_lead", "p2")).not.toBe(h.tokens.generation(S1, "tech_lead", "p1")); // a reissue or rebind
    expect(h.tokens.generation(S1, "cfo", "p1")).not.toBe(h.tokens.generation(S1, "tech_lead", "p1"));
  });

  it("a control restart (new VoiceTokens, new key) gives a different generation for the same participant", () => {
    const a = harness({ random: randomBytes });
    const b = harness({ random: randomBytes });
    a.tokens.openSession(S1);
    b.tokens.openSession(S1);
    expect(a.tokens.generation(S1, "tech_lead", "p1")).not.toBe(b.tokens.generation(S1, "tech_lead", "p1"));
  });

  it("the generation leaks nothing of the participant id: 8 lower-case hex", () => {
    const h = harness();
    h.tokens.openSession(S1);
    expect(h.tokens.generation(S1, "tech_lead", "participant-123")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("VoiceTokens.issue: who gets a token (US-0071, A1b Task 5, K1)", () => {
  it("gives a token for the caller's own seat room only to the holder whose voiceChosen is true", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1"), holder("cfo", "p2")]));
    const t = await h.tokens.issue(S1, "tech_lead", "p1");
    expect(t).toEqual({ token: "jwt-participant-1", expiresAt: 600_000 });
    expect(h.minted).toEqual([{ kind: "participant", room: h.tokens.roomOf(S1, "tech_lead"), identity: expect.stringMatching(/^tech_lead\.g[0-9a-f]{8}$/), token: "jwt-participant-1" }]);
  });

  it("is given before the start and while paused (the worker's allowed set is empty then)", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1", { recording: false })], [], { paused: true }));
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "p1"))).toBe("resolved");
  });

  it("refuses another participant, voiceChosen false and an AI seat (absent from holders) voice_refused after the wait", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1"), holder("cfo", "p2", { voiceChosen: false })]));
    const other = h.tokens.issue(S1, "tech_lead", "p9");
    const notChosen = h.tokens.issue(S1, "cfo", "p2");
    const ai = h.tokens.issue(S1, "delivery_lead", "bot");
    h.fire(SEATS_WAIT_MS);
    expect(await refusal(other)).toBe("voice_refused");
    expect(await refusal(notChosen)).toBe("voice_refused");
    expect(await refusal(ai)).toBe("voice_refused");
    expect(h.minted).toEqual([]);
  });

  it("refuses an unknown session, an ended session (seats ended or endSession) and LiveKit-less use voice_unavailable at once", async () => {
    const h = harness();
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "p1"))).toBe("voice_unavailable");
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")], [], { ended: true }));
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "p1"))).toBe("voice_unavailable");
    h.tokens.openSession(S2);
    h.tokens.seatsChanged(S2, seats([holder("tech_lead", "p1")]));
    h.tokens.endSession(S2);
    expect(await refusal(h.tokens.issue(S2, "tech_lead", "p1"))).toBe("voice_unavailable");
    expect(h.minted).toEqual([]);
  });

  it("after voiceOff every request is refused voice_off at once", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    h.tokens.voiceOff(S1);
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "p1"))).toBe("voice_off");
  });

  it("a request before the seats arrive waits and succeeds when they arrive within 1000 ms", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const p = h.tokens.issue(S1, "tech_lead", "p1");
    await settle();
    expect(h.timers.filter((t) => t.ms === SEATS_WAIT_MS && !t.cancelled)).toHaveLength(1);
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2")])); // an unrelated change: still waiting
    await settle();
    expect(h.minted).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2"), holder("tech_lead", "p1")]));
    expect(await refusal(p)).toBe("resolved");
    expect(h.timers.filter((t) => t.ms === SEATS_WAIT_MS).every((t) => t.cancelled)).toBe(true);
  });

  it("is refused after 1000 ms without seats", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const p = h.tokens.issue(S1, "tech_lead", "p1");
    h.fire(SEATS_WAIT_MS);
    expect(await refusal(p)).toBe("voice_refused");
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")])); // too late: nothing is minted for the refused request
    await settle();
    expect(h.minted).toEqual([]);
  });

  it("a second concurrent waiting request for the seat is refused at once", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const first = h.tokens.issue(S1, "tech_lead", "p1");
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "p1"))).toBe("voice_refused");
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(await refusal(first)).toBe("resolved");
  });

  it("a waiting request is refused voice_off by voiceOff and voice_unavailable by endSession", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const a = h.tokens.issue(S1, "tech_lead", "p1");
    h.tokens.voiceOff(S1);
    expect(await refusal(a)).toBe("voice_off");
    h.tokens.openSession(S2);
    const b = h.tokens.issue(S2, "tech_lead", "p1");
    h.tokens.endSession(S2);
    expect(await refusal(b)).toBe("voice_unavailable");
  });

  it("after the runtime exited the old seats no longer grant a token (the next seats do)", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    h.tokens.runtimeExited(S1);
    const p = h.tokens.issue(S1, "tech_lead", "p1");
    await settle();
    expect(h.minted).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(await refusal(p)).toBe("resolved");
  });

  it("a mint failure is refused voice_unavailable and logged by name only", async () => {
    const h = harness();
    const t = new VoiceTokens({
      cfg: CFG, admin: h.admin, random: seeded("m"), log: (m) => h.logs.push(m), setTimer: () => () => {},
      mint: async () => { const e = new Error("secret leaked tech_lead.g12345678"); e.name = "LiveKitTokenError"; throw e; },
      mintWorker: async () => { throw new Error("x"); },
    });
    t.openSession(S1);
    t.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(await refusal(t.issue(S1, "tech_lead", "p1"))).toBe("voice_unavailable");
    expect(h.logs).toEqual([`session ${S1} voice token could not be minted (LiveKitTokenError)`]);
  });
});

describe("VoiceTokens: removing stale identities (US-0071, A1b Task 5, R7, AC-c)", () => {
  /** A session whose tech_lead seat room exists, with the current holder's identity (and any extra ones) connected. */
  async function seated(extra: string[] = []) {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await h.tokens.issue(S1, "tech_lead", "p1");
    const room = h.tokens.roomOf(S1, "tech_lead");
    const p1 = h.minted[0]!.identity;
    h.admin.join(room, p1);
    for (const x of extra) h.admin.join(room, x);
    await settle();
    h.admin.calls = [];
    return { h, room, p1 };
  }

  it("a new holder for a role removes the old identity (a reissue or rebind with the old browser still in the room)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
    expect(h.admin.in(room)).toEqual([]);
  });

  it("a plain disconnect removes no identity (holder gone, role in open)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([], ["tech_lead"]));
    await settle();
    expect(h.admin.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(h.admin.in(room)).toEqual([p1]);
    // ...and the same participant coming back keeps the same identity: still nothing removed.
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await settle();
    expect(h.admin.in(room)).toEqual([p1]);
  });

  it("leave, withdraw and AI fill remove (holder gone, role not in open)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([], []));
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
  });

  it("an opt-out (voiceChosen false) removes it", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1", { voiceChosen: false })]));
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
  });

  it("mute, pause and voice unavailable remove nothing (voiceChosen still true)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1", { recording: false })], [], { paused: true }));
    await settle();
    expect(h.admin.in(room)).toEqual([p1]);
  });

  it("roleReissued removes it at once, before any seat change", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.roleReissued(S1, "tech_lead");
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
  });

  it("after roleReissued a report that shows the seat open still expects nothing until a new holder binds (a whole-session reissue restarts the runtime)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.roleReissued(S1, "tech_lead");
    h.tokens.runtimeExited(S1);
    h.tokens.seatsChanged(S1, seats([], ["tech_lead"])); // the relaunched runtime: nobody bound, every seat open
    await settle();
    h.admin.join(room, p1); // the old browser reconnects
    h.tokens.seatsChanged(S1, seats([], ["tech_lead"]));
    await settle();
    expect(h.admin.in(room)).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")])); // the next person binds: their identity is expected now
    await settle();
    const p2 = `tech_lead.g${h.tokens.generation(S1, "tech_lead", "p2")}`;
    h.admin.join(room, p2);
    h.tokens.seatsChanged(S1, seats([], ["tech_lead"])); // and their reload keeps them
    await settle();
    expect(h.admin.in(room)).toEqual([p2]);
  });

  it("voiceOff removes every seat identity", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.voiceOff(S1);
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
  });

  it("the sweep removes a stale identity that reconnected (its token was still valid)", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    expect(h.admin.in(room)).toEqual([]);
    h.admin.join(room, p1); // the removed browser reconnects with its 10-minute token
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2"), holder("cfo", "p3")]));
    await settle();
    expect(h.admin.calls.filter((c) => c === `remove ${room} ${p1}`)).toHaveLength(2);
    expect(h.admin.in(room)).toEqual([]);
  });

  it("the sweep keeps the current holder and never removes the worker identity", async () => {
    const { h, room, p1 } = await seated(["SPEECH.0123abcd"]);
    const stale = `tech_lead.g${"0".repeat(8)}`;
    h.admin.join(room, stale);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1"), holder("cfo", "p3")]));
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${stale}`]);
    expect(h.admin.in(room).sort()).toEqual([p1, "SPEECH.0123abcd"].sort());
  });

  it("an identity that is not a seat identity of the room's role is removed too (only the expected one and the worker stay)", async () => {
    const { h, room, p1 } = await seated(["cfo.g12345678", "Someone"]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await settle();
    expect(h.admin.in(room)).toEqual([p1]);
  });

  it("sweeps are serialised per room and coalesced (one in flight, one pending)", async () => {
    const { h, room } = await seated();
    h.admin.hold = true;
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p3")]));
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p4")]));
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`]); // one in flight
    h.admin.hold = false;
    h.admin.held.shift()!.resolve();
    await settle();
    expect(h.admin.calls.filter((c) => c.startsWith("list"))).toHaveLength(2); // the pending one ran once for all three changes
  });

  it("a seat that never had a token has no room: nothing is listed", () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    h.tokens.seatsChanged(S1, seats([]));
    expect(h.admin.calls).toEqual([]);
  });

  it("endSession deletes every seat room and forgets the session", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const a = h.tokens.roomOf(S1, "tech_lead");
    const b = h.tokens.roomOf(S1, "cfo");
    h.tokens.endSession(S1);
    await settle();
    expect(h.admin.deleted.sort()).toEqual([a, b].sort());
    expect(() => h.tokens.roomOf(S1, "tech_lead")).toThrow(RangeError);
  });
});

describe("VoiceTokens.workerJoin (US-0071, A1b Task 5)", () => {
  it("mints a fresh hidden worker token per call for a recording seat, for that seat's room", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    const a = await h.tokens.workerJoin(S1, "tech_lead");
    const b = await h.tokens.workerJoin(S1, "tech_lead");
    expect(a.url).toBe("ws://127.0.0.1:7880");
    expect(a.room).toBe(h.tokens.roomOf(S1, "tech_lead"));
    expect(a.token).not.toBe(b.token);
    expect(h.minted.map((m) => m.kind)).toEqual(["worker", "worker"]);
    for (const m of h.minted) { expect(m.identity).toMatch(/^SPEECH\.[0-9a-f]{8}$/); expect(parseParticipantIdentity(m.identity)).toBeNull(); }
  });

  it("rejects for a non-recording seat, a paused session, an unknown role, after voiceOff and for an unknown session", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1", { recording: false }), holder("cfo", "p2")]));
    expect(await refusal(h.tokens.workerJoin(S1, "tech_lead"))).toBe("voice_refused");
    expect(await refusal(h.tokens.workerJoin(S1, "delivery_lead"))).toBe("voice_refused");
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2")], [], { paused: true }));
    expect(await refusal(h.tokens.workerJoin(S1, "cfo"))).toBe("voice_refused");
    expect(await refusal(h.tokens.workerJoin(S2, "cfo"))).toBe("voice_unavailable");
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2")]));
    h.tokens.voiceOff(S1);
    expect(await refusal(h.tokens.workerJoin(S1, "cfo"))).toBe("voice_off");
    expect(h.minted).toEqual([]);
  });
});

describe("VoiceTokens: logging (US-0071, A1b Task 5, batch 2 review F7)", () => {
  it("an admin failure is logged by name and never thrown", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await h.tokens.issue(S1, "tech_lead", "p1");
    const room = h.tokens.roomOf(S1, "tech_lead");
    const identity = h.minted[0]!.identity;
    h.admin.join(room, identity);
    h.admin.failAll = true;
    expect(() => h.tokens.seatsChanged(S1, seats([]))).not.toThrow();
    expect(() => h.tokens.endSession(S1)).not.toThrow();
    await settle();
    expect([...h.logs].sort()).toEqual([`session ${S1} voice participant sweep failed (LiveKitAdminError)`, `session ${S1} voice room delete failed (LiveKitAdminError)`]);
    const all = h.logs.join("\n");
    expect(all).not.toContain(room);
    expect(all).not.toContain(identity);
  });

  it("nothing logged contains a room, an identity, a participant id or a token", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "participant-secret-1")]));
    await h.tokens.issue(S1, "tech_lead", "participant-secret-1");
    await h.tokens.workerJoin(S1, "tech_lead");
    const room = h.tokens.roomOf(S1, "tech_lead");
    h.admin.join(room, h.minted[0]!.identity);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "participant-secret-2")]));
    h.tokens.roleReissued(S1, "tech_lead");
    h.admin.failAll = true;
    h.tokens.voiceOff(S1);
    h.tokens.endSession(S1);
    await settle();
    const all = h.logs.join("\n");
    for (const secret of [room, "participant-secret", "jwt-", ...h.minted.map((m) => m.identity), ...h.minted.map((m) => m.token)]) expect(all).not.toContain(secret);
  });
});

describe("VoiceTokens: the periodic sweep (US-0071, A1b batch 3 review F3)", () => {
  const live = (h: ReturnType<typeof harness>) => h.timers.filter((t) => t.ms === SWEEP_INTERVAL_MS && !t.cancelled);
  async function seated() {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await h.tokens.issue(S1, "tech_lead", "p1");
    const room = h.tokens.roomOf(S1, "tech_lead");
    h.admin.join(room, h.minted[0]!.identity);
    await settle();
    h.admin.calls = [];
    return { h, room, p1: h.minted[0]!.identity };
  }

  it("a removed browser that reconnects with its still-valid token is removed again within one period, with no seat change", async () => {
    const { h, room, p1 } = await seated();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    expect(h.admin.in(room)).toEqual([]);
    h.admin.join(room, p1); // reconnects (TTL 600 s); no seat change follows
    h.admin.calls = [];
    expect(live(h)).toHaveLength(1);
    h.fire(SWEEP_INTERVAL_MS);
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`, `remove ${room} ${p1}`]);
    expect(live(h)).toHaveLength(1); // armed again for the next period
  });

  it("one timer per session however many seat reports arrive; it keeps the current holder", async () => {
    const { h, room, p1 } = await seated();
    for (let i = 0; i < 5; i++) h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await settle();
    expect(live(h)).toHaveLength(1);
    h.admin.calls = [];
    h.fire(SWEEP_INTERVAL_MS);
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`]);
    expect(h.admin.in(room)).toEqual([p1]);
  });

  it("the timer stops at endSession", async () => {
    const { h } = await seated();
    expect(live(h)).toHaveLength(1);
    h.tokens.endSession(S1);
    expect(live(h)).toEqual([]);
  });

  it("the timer stops when the runtime exits and starts again with the next runtime's seats", async () => {
    const { h } = await seated();
    h.tokens.runtimeExited(S1);
    expect(live(h)).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(live(h)).toHaveLength(1);
  });

  it("no periodic sweep without rooms (seats alone arm nothing)", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(live(h)).toEqual([]);
  });

  it("a periodic sweep while one is in flight is coalesced into the room's pending run", async () => {
    const { h, room } = await seated();
    h.admin.hold = true;
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    h.fire(SWEEP_INTERVAL_MS);
    await settle();
    expect(h.admin.calls).toEqual([`list ${room}`]);
    h.admin.hold = false;
    h.admin.held.shift()!.resolve();
    await settle();
    expect(h.admin.calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
  });
});

describe("VoiceTokens: a failed sweep is retried once (US-0071, A1b batch 3 review F7)", () => {
  const retries = (h: ReturnType<typeof harness>) => h.timers.filter((t) => t.ms === SWEEP_RETRY_MS && !t.cancelled);
  async function seated() {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    await h.tokens.issue(S1, "tech_lead", "p1");
    const room = h.tokens.roomOf(S1, "tech_lead");
    h.admin.join(room, h.minted[0]!.identity);
    await settle();
    h.admin.calls = [];
    return { h, room, p1: h.minted[0]!.identity };
  }

  it("a sweep that fails (LiveKit briefly down) is retried once after SWEEP_RETRY_MS and then removes the identity", async () => {
    const { h, room } = await seated();
    h.admin.failAll = true;
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    expect(retries(h)).toHaveLength(1);
    h.admin.failAll = false;
    h.fire(SWEEP_RETRY_MS);
    await settle();
    expect(h.admin.in(room)).toEqual([]);
    expect(retries(h)).toEqual([]);
  });

  it("a retry that fails again schedules no further retry (the periodic sweep covers it); endSession cancels a pending retry", async () => {
    const { h } = await seated();
    h.admin.failAll = true;
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    h.fire(SWEEP_RETRY_MS);
    await settle();
    expect(retries(h)).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p3")]));
    await settle();
    expect(retries(h)).toHaveLength(1);
    h.tokens.endSession(S1);
    expect(retries(h)).toEqual([]);
  });

  it("several failed sweeps of one room keep one pending retry", async () => {
    const { h } = await seated();
    h.admin.failAll = true;
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    await settle();
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p3")]));
    await settle();
    expect(retries(h)).toHaveLength(1);
  });
});

describe("VoiceTokens.issue: who may wait (US-0071, A1b batch 3 review F4)", () => {
  const waits = (h: ReturnType<typeof harness>) => h.timers.filter((t) => t.ms === SEATS_WAIT_MS && !t.cancelled).length;

  it("a request for a seat that the seats list for another participant is refused at once (no wait)", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "stale-cookie"))).toBe("voice_refused");
    expect(waits(h)).toBe(0);
  });

  it("a stale request cannot starve the real holder: both wait independently and the holder is answered by the seats", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const stale = h.tokens.issue(S1, "tech_lead", "old-tab");
    const real = h.tokens.issue(S1, "tech_lead", "p1"); // was refused at once while the stale request waited
    expect(waits(h)).toBe(2);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    expect(await refusal(real)).toBe("resolved");
    expect(await refusal(stale)).toBe("voice_refused"); // refused by the same report, not after the full wait
  });

  it("waits when the seat has no holder, or the caller holds it without voiceChosen yet", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2", { voiceChosen: false })], ["tech_lead"]));
    const empty = h.tokens.issue(S1, "tech_lead", "p1");
    const choosing = h.tokens.issue(S1, "cfo", "p2");
    expect(waits(h)).toBe(2);
    h.tokens.seatsChanged(S1, seats([holder("cfo", "p2"), holder("tech_lead", "p1")]));
    expect(await refusal(empty)).toBe("resolved");
    expect(await refusal(choosing)).toBe("resolved");
  });

  it(`at most ${MAX_WAITERS_PER_ROLE} requests wait per seat; one more is refused at once`, async () => {
    const h = harness();
    h.tokens.openSession(S1);
    const waiting = Array.from({ length: MAX_WAITERS_PER_ROLE }, (_, i) => h.tokens.issue(S1, "tech_lead", `p${i}`));
    expect(await refusal(h.tokens.issue(S1, "tech_lead", "one-more"))).toBe("voice_refused");
    expect(waits(h)).toBe(MAX_WAITERS_PER_ROLE);
    h.fire(SEATS_WAIT_MS);
    for (const p of waiting) expect(await refusal(p)).toBe("voice_refused");
  });

  it("while a seat is reissued, the old seats never grant a token: the old holder waits and is refused, the new holder is answered by its report", async () => {
    const h = harness();
    h.tokens.openSession(S1);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p1")]));
    h.tokens.roleReissued(S1, "tech_lead");
    const old = h.tokens.issue(S1, "tech_lead", "p1"); // the stale seats still list p1 with voice
    const next = h.tokens.issue(S1, "tech_lead", "p2");
    await settle();
    expect(h.minted).toEqual([]);
    h.tokens.seatsChanged(S1, seats([holder("tech_lead", "p2")]));
    expect(await refusal(next)).toBe("resolved");
    expect(await refusal(old)).toBe("voice_refused");
    expect(h.minted.map((m) => m.identity)).toEqual([`tech_lead.g${h.tokens.generation(S1, "tech_lead", "p2")}`]);
  });
});
