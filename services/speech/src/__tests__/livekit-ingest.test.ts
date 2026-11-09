import { describe, expect, it } from "vitest";
import {
  JOIN_ATTEMPTS, JOIN_RETRY_MS, LIVEKIT_INGEST_FAILED, MAX_TRACK_RESTARTS, LiveKitIngest, LiveKitJoinRefused, LiveKitJoinTimeout, type LiveKitJoinInfo,
} from "../ingest/livekit-ingest.js";
import { FakeRoomPort, chunk, mic, type FakeConn } from "./fake-room.js";

// US-0071 (EPIC-0003 voice A1b, Task 7, Review Focus 1 and 2): the LiveKit ingest subscribes only to the current recording holder's
// microphone track and attributes every frame to the generation whose track produced it, checked frame by frame.
const G1 = "11111111";
const G2 = "22222222";
const G3 = "33333333";
const A1 = `alice.g${G1}`;
const A3 = `alice.g${G3}`;
const B2 = `bob.g${G2}`;

type Frame = { roleId: string; generation: string | undefined; first: number; length: number };
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

type Timer = { fn: () => void; ms: number; cancelled: boolean };
type PendingJoin = { roleId: string; resolve: () => void; reject: (e: Error) => void };

function harness(o: { joinFails?: (roleId: string) => boolean; manualJoins?: boolean } = {}) {
  const port = new FakeRoomPort();
  const joins: string[] = [];
  const status: string[] = [];
  const frames: Frame[] = [];
  const timers: Timer[] = [];
  /** With `manualJoins`, every join waits here until the test answers it (as control and the worker's wait would). */
  const pending: PendingJoin[] = [];
  let n = 0;
  const info = (roleId: string): LiveKitJoinInfo => ({ url: "ws://127.0.0.1:7880", token: `tok-${roleId}-${++n}`, room: `v${"0".repeat(32)}` });
  const ingest = new LiveKitIngest({
    room: port,
    join: async (roleId) => {
      joins.push(roleId);
      if (o.manualJoins) {
        await new Promise<void>((resolve, reject) => pending.push({ roleId, resolve, reject }));
        return info(roleId);
      }
      if (o.joinFails?.(roleId)) throw new Error("timeout");
      return info(roleId);
    },
    onStatus: (s) => status.push(s),
    setTimer: (fn, ms) => { const t: Timer = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
  });
  const fire = (ms: number): void => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
  const live = (ms: number): Timer[] => timers.filter((t) => t.ms === ms && !t.cancelled);
  let settled: "pending" | "resolved" | "rejected" = "pending";
  let rejection: unknown;
  const start = (): Promise<void> => {
    const p = ingest.start((roleId, generation, frame) => { frames.push({ roleId, generation, first: frame[0]!, length: frame.length }); });
    p.then(() => { settled = "resolved"; }, (e: unknown) => { settled = "rejected"; rejection = e; });
    return p;
  };
  /** The connection opened for the n-th join (in join order). */
  const conn = (i = 0): FakeConn => port.conns[i] as FakeConn;
  return { ingest, port, joins, status, frames, start, conn, timers, fire, live, pending, state: () => settled, rejection: () => rejection };
}

describe("LiveKitIngest: what is subscribed (US-0071, A1b Task 7, Review Focus 1)", () => {
  it("an unconsented published track is never subscribed: only alice (allowed) is, bob (not allowed) gets no frame", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.joins).toEqual(["alice"]); // bob's seat room is never even joined
    h.conn(0).publish(mic(A1, "TR_a"));
    h.conn(0).publish(mic(B2, "TR_b")); // an identity of another role in alice's room (never happens with real tokens)
    h.conn(0).push("TR_a", chunk(1));
    h.conn(0).push("TR_b", chunk(2));
    await settle();
    expect(h.conn(0).calls.filter((c) => c.startsWith("subscribe"))).toEqual(["subscribe TR_a"]);
    expect(h.frames.map((f) => [f.roleId, f.generation, f.first])).toEqual([["alice", G1, 1]]);
  });

  it("before the start nothing is subscribed (allowed empty): no room is joined", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map());
    await settle();
    expect(h.joins).toEqual([]);
    expect(h.port.opened).toEqual([]);
  });

  it("setAllowed before start is kept and applied when the ingest starts", async () => {
    const h = harness();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.joins).toEqual([]);
    h.start();
    await settle();
    expect(h.joins).toEqual(["alice"]);
  });

  it("paused or ended gives an empty allowed set and unsubscribes every track; resume subscribes again", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    await settle();
    h.ingest.setAllowed(new Map()); // pause
    expect(h.conn(0).calls).toContain("unsubscribe TR_a");
    h.conn(0).push("TR_a", chunk(5)); // audio spoken during the pause
    await settle();
    expect(h.frames).toEqual([]);
    h.ingest.setAllowed(new Map([["alice", G1]])); // resume
    await settle();
    expect(h.conn(0).calls.filter((c) => c === "subscribe TR_a")).toHaveLength(2);
    h.conn(0).push("TR_a", chunk(6));
    await settle();
    expect(h.frames.map((f) => f.first)).toEqual([6]); // the pause's audio never comes out, the resumed audio does
    expect(h.joins).toEqual(["alice"]); // the room connection was kept
  });

  it("setAllowed without a role unsubscribes its track at once (synchronously)", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    h.ingest.setAllowed(new Map());
    expect(h.conn(0).calls.slice(-2)).toEqual(["return TR_a", "unsubscribe TR_a"]);
  });

  it("a track whose generation is not current is ignored", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G3]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_old"));
    h.conn(0).push("TR_old", chunk(1));
    await settle();
    expect(h.conn(0).calls).toEqual([]);
    expect(h.frames).toEqual([]);
  });

  it("a second microphone track of the same identity is not subscribed (at most one per identity)", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_1"));
    h.conn(0).publish(mic(A1, "TR_2"));
    h.conn(0).push("TR_1", chunk(1));
    h.conn(0).push("TR_2", chunk(2));
    await settle();
    expect(h.conn(0).calls.filter((c) => c.startsWith("subscribe"))).toEqual(["subscribe TR_1"]);
    expect(h.frames.map((f) => f.first)).toEqual([1]);
    // When the first one goes, the second may take its place (still one at a time).
    h.conn(0).unpublish(A1, "TR_1");
    await settle();
    expect(h.conn(0).calls.filter((c) => c.startsWith("subscribe"))).toEqual(["subscribe TR_1", "subscribe TR_2"]);
  });

  it("a video or non-microphone audio track is never subscribed", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish({ identity: A1, trackSid: "TR_v", kind: "video", source: "other" });
    h.conn(0).publish({ identity: A1, trackSid: "TR_s", kind: "audio", source: "other" }); // screen-share audio
    h.conn(0).publish({ identity: A1, trackSid: "TR_u", kind: "unknown", source: "microphone" });
    await settle();
    expect(h.conn(0).calls).toEqual([]);
  });

  it("an identity that does not parse (SPEECH.deadbeef, Tech.g12345678, a.b, alice) is never subscribed", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    for (const [i, id] of ["SPEECH.deadbeef", "Tech.g12345678", "a.b", "alice", `alice.G${G1}`, `alice.g${G1}x`, `x.alice.g${G1}`].entries()) h.conn(0).publish(mic(id, `TR_${i}`));
    await settle();
    expect(h.conn(0).calls).toEqual([]);
  });

  it("an identity of another role in a seat room is never subscribed, even when that role is allowed", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1], ["bob", G2]]));
    await settle();
    expect(h.joins.sort()).toEqual(["alice", "bob"]);
    const aliceRoom = h.conn(h.joins.indexOf("alice"));
    aliceRoom.publish(mic(B2, "TR_b_in_alice")); // bob's identity in alice's seat room
    await settle();
    expect(aliceRoom.calls).toEqual([]);
  });

  it("a holder that comes back is subscribed again (a reload: the track is unpublished and published again)", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    await settle();
    h.ingest.setAllowed(new Map()); // the seat has no holder for a moment (socket closed)
    h.conn(0).unpublish(A1, "TR_a");
    h.ingest.setAllowed(new Map([["alice", G1]])); // the same participant is back
    h.conn(0).publish(mic(A1, "TR_a2"));
    h.conn(0).push("TR_a2", chunk(9));
    await settle();
    expect(h.conn(0).calls.filter((c) => c.startsWith("subscribe"))).toEqual(["subscribe TR_a", "subscribe TR_a2"]);
    expect(h.frames.map((f) => [f.generation, f.first])).toEqual([[G1, 9]]);
  });

  it("tracks already in the room when the worker joins are considered", async () => {
    const h = harness();
    h.port.initial = [mic(A1, "TR_early")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.conn(0).calls).toContain("subscribe TR_early");
  });
});

describe("LiveKitIngest: attribution frame by frame (US-0071, A1b Task 7, Review Focus 2)", () => {
  it("frames queued after unsubscribe are never delivered: alice.g11111111 frames the room keeps yielding after the move to g33333333", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_old"));
    h.conn(0).push("TR_old", chunk(1));
    await settle();
    expect(h.frames.map((f) => [f.generation, f.first])).toEqual([[G1, 1]]);
    // The race the per-frame check exists for: a frame has already reached the loop's pending read when the seat changes hands.
    h.conn(0).push("TR_old", chunk(2));
    h.ingest.setAllowed(new Map([["alice", G3]]));
    h.conn(0).push("TR_old", chunk(3)); // the room keeps yielding the old identity's audio after the unsubscribe
    await settle();
    expect(h.frames.filter((f) => f.generation === G1).map((f) => f.first)).toEqual([1]);
    expect(h.frames.every((f) => f.generation !== G1 || f.first === 1)).toBe(true);
  });

  it("two tracks of one role never interleave: every delivered frame carries the current generation, in order", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_old"));
    h.conn(0).publish(mic(A3, "TR_new")); // the next holder's browser joins while the old one is still in the room
    for (let i = 1; i <= 3; i++) { h.conn(0).push("TR_old", chunk(100 + i)); h.conn(0).push("TR_new", chunk(300 + i)); }
    await settle();
    h.ingest.setAllowed(new Map([["alice", G3]]));
    for (let i = 4; i <= 6; i++) { h.conn(0).push("TR_old", chunk(100 + i)); h.conn(0).push("TR_new", chunk(300 + i)); }
    await settle();
    const gens = h.frames.map((f) => f.generation);
    const firstNew = gens.indexOf(G3);
    expect(gens.slice(0, firstNew).every((g) => g === G1)).toBe(true);
    expect(gens.slice(firstNew).every((g) => g === G3)).toBe(true);
    expect(h.frames.map((f) => f.first)).toEqual([101, 102, 103, 304, 305, 306]);
    for (const f of h.frames) expect(f.first < 200 ? G1 : G3).toBe(f.generation);
  });

  it("frames reach onFrame as 320-sample frames tagged with role and generation, whatever size the room delivers", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    h.conn(0).push("TR_a", chunk(1, 160));
    h.conn(0).push("TR_a", chunk(1, 500));
    h.conn(0).push("TR_a", chunk(1, 300));
    await settle();
    expect(h.frames).toEqual([
      { roleId: "alice", generation: G1, first: 1, length: 320 }, { roleId: "alice", generation: G1, first: 1, length: 320 },
      { roleId: "alice", generation: G1, first: 1, length: 320 },
    ]);
  });

  it("a re-subscription starts a fresh frame buffer (no samples of before carried over)", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    h.conn(0).push("TR_a", chunk(7, 300)); // 300 samples wait for 20 more
    await settle();
    h.ingest.setAllowed(new Map());
    h.ingest.setAllowed(new Map([["alice", G1]]));
    h.conn(0).push("TR_a", chunk(8, 320));
    await settle();
    expect(h.frames.map((f) => f.first)).toEqual([8]);
  });
});

describe("LiveKitIngest: connections (US-0071, A1b Task 7)", () => {
  it("each seat connect asks for a fresh token (two seats, two join calls; a token is never reused)", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1], ["bob", G2]]));
    await settle();
    expect(h.joins.sort()).toEqual(["alice", "bob"]);
    expect(new Set(h.port.opened.map((o) => o.token)).size).toBe(2);
    expect(h.status).toEqual(["connected", "connected"]);
    h.ingest.setAllowed(new Map([["alice", G1]]));
    h.ingest.setAllowed(new Map([["alice", G1], ["bob", G2]]));
    await settle();
    expect(h.joins).toHaveLength(2); // the connection is kept for the session
  });

  it("a join that fails while the role is allowed reports failed and start settles (rejected with the fixed sentence)", async () => {
    const h = harness({ joinFails: () => true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.status).toEqual(["failed"]);
    expect(h.state()).toBe("rejected");
    expect((h.rejection() as Error).message).toBe(LIVEKIT_INGEST_FAILED);
  });

  it("a join that fails after the role stopped being allowed (a pause meanwhile) is dropped quietly and retried when allowed again", async () => {
    let fail = true;
    const h = harness({ joinFails: () => fail });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    h.ingest.setAllowed(new Map());
    await settle();
    expect(h.status).toEqual([]);
    expect(h.state()).toBe("pending");
    fail = false;
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.joins).toEqual(["alice", "alice"]);
    expect(h.status).toEqual(["connected"]);
  });

  it("a failed open reports failed and start rejects with a fixed sentence (never the token or the URL)", async () => {
    const h = harness();
    h.port.failNext = new Error("could not connect to ws://127.0.0.1:7880 with tok-alice-1");
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.status).toEqual(["failed"]);
    expect(h.state()).toBe("rejected");
    expect((h.rejection() as Error).message).toBe(LIVEKIT_INGEST_FAILED);
    expect(String(h.rejection())).not.toContain("tok-");
  });

  it("a disconnect of an allowed room reports disconnected and start settles", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    h.conn(0).drop();
    await settle();
    expect(h.status).toEqual(["connected", "disconnected"]);
    expect(h.state()).toBe("rejected");
    h.conn(0).push("TR_a", chunk(1));
    await settle();
    expect(h.frames).toEqual([]);
  });

  it("a disconnect of a room whose role is not allowed now is forgotten quietly; allowing it again joins afresh", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.ingest.setAllowed(new Map());
    h.conn(0).drop();
    await settle();
    expect(h.state()).toBe("pending");
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.joins).toEqual(["alice", "alice"]);
    expect(h.port.conns).toHaveLength(2);
  });

  it("stop disconnects every room, ends every loop, delivers nothing more and resolves start", async () => {
    const h = harness();
    const started = h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.conn(0).publish(mic(A1, "TR_a"));
    await settle();
    await h.ingest.stop();
    await expect(started).resolves.toBeUndefined();
    expect(h.conn(0).disconnected).toBe(true);
    h.conn(0).push("TR_a", chunk(1));
    h.ingest.setAllowed(new Map([["alice", G1]])); // nothing reopens after a stop
    await settle();
    expect(h.frames).toEqual([]);
    expect(h.joins).toEqual(["alice"]);
  });

  it("a room that opens after stop is disconnected at once", async () => {
    const h = harness();
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await h.ingest.stop(); // the join is still in flight
    await settle();
    expect(h.port.conns[0]?.disconnected ?? true).toBe(true);
  });
});

describe("LiveKitIngest: a join control refused or did not answer (US-0071, A1b batch 3 review F1)", () => {
  it("allowed, pause, resume while the join is pending, then the join is refused: it joins again after the backoff and nothing fails", async () => {
    const h = harness({ manualJoins: true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.ingest.setAllowed(new Map()); // pause: control would now refuse the worker's join
    h.ingest.setAllowed(new Map([["alice", G1]])); // resume before the answer
    await settle();
    expect(h.joins).toEqual(["alice"]); // one join in flight, not two
    h.pending.shift()!.reject(new LiveKitJoinRefused());
    await settle();
    expect(h.status).toEqual([]);
    expect(h.state()).toBe("pending");
    expect(h.live(JOIN_RETRY_MS)).toHaveLength(1);
    h.ingest.setAllowed(new Map([["alice", G1]])); // a seat report meanwhile does not jump the backoff
    await settle();
    expect(h.joins).toEqual(["alice"]);
    h.fire(JOIN_RETRY_MS);
    await settle();
    expect(h.joins).toEqual(["alice", "alice"]);
    h.pending.shift()!.resolve();
    await settle();
    expect(h.status).toEqual(["connected"]);
    h.conn(0).publish(mic(A1, "TR_a"));
    h.conn(0).push("TR_a", chunk(4));
    await settle();
    expect(h.frames.map((f) => f.first)).toEqual([4]);
  });

  it("a runtime restart during the join (allowed, then nobody, then the new runtime's seats) and a join timeout: joins again, nothing fails", async () => {
    const h = harness({ manualJoins: true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.ingest.setAllowed(new Map()); // detach: control tells the worker nobody records
    h.ingest.setAllowed(new Map([["alice", G1]])); // the new runtime reports the same holder
    h.pending.shift()!.reject(new LiveKitJoinTimeout()); // control refused while there were no seats and the answer was lost
    await settle();
    expect(h.status).toEqual([]);
    h.fire(JOIN_RETRY_MS);
    await settle();
    h.pending.shift()!.resolve();
    await settle();
    expect(h.status).toEqual(["connected"]);
    expect(h.state()).toBe("pending");
  });

  it(`a join refused ${JOIN_ATTEMPTS} times in a row while allowed reports failed`, async () => {
    const h = harness({ manualJoins: true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    for (let i = 1; i <= JOIN_ATTEMPTS; i++) {
      await settle();
      expect(h.joins).toHaveLength(i);
      h.pending.shift()!.reject(new LiveKitJoinRefused());
      await settle();
      if (i < JOIN_ATTEMPTS) { expect(h.status).toEqual([]); h.fire(JOIN_RETRY_MS); }
    }
    expect(h.status).toEqual(["failed"]);
    expect(h.state()).toBe("rejected");
    expect((h.rejection() as Error).message).toBe(LIVEKIT_INGEST_FAILED);
  });

  it("a refusal for a role that is not allowed now is quiet and sets no retry; allowing it again joins at once", async () => {
    const h = harness({ manualJoins: true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.ingest.setAllowed(new Map());
    h.pending.shift()!.reject(new LiveKitJoinRefused());
    await settle();
    expect(h.status).toEqual([]);
    expect(h.live(JOIN_RETRY_MS)).toEqual([]);
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    expect(h.joins).toEqual(["alice", "alice"]);
  });

  it("a pending retry does nothing once the role is no longer allowed, and stop cancels it", async () => {
    const h = harness({ manualJoins: true });
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.pending.shift()!.reject(new LiveKitJoinRefused());
    await settle();
    h.ingest.setAllowed(new Map());
    h.fire(JOIN_RETRY_MS);
    await settle();
    expect(h.joins).toEqual(["alice"]);
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.pending.shift()!.reject(new LiveKitJoinRefused());
    await settle();
    expect(h.live(JOIN_RETRY_MS)).toHaveLength(1);
    await h.ingest.stop();
    expect(h.live(JOIN_RETRY_MS)).toEqual([]);
  });

  it("a real room.open failure after a granted join still reports failed at once (no retry)", async () => {
    const h = harness({ manualJoins: true });
    h.port.failNext = new Error("no server");
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    h.pending.shift()!.resolve();
    await settle();
    expect(h.status).toEqual(["failed"]);
    expect(h.state()).toBe("rejected");
    expect(h.live(JOIN_RETRY_MS)).toEqual([]);
  });
});

describe("LiveKitIngest: a track stream that ends while its seat records (US-0071, A1b batch 3 review F2)", () => {
  it("the stream ends without an unpublish while allowed: the track is subscribed again and frames flow again", async () => {
    const h = harness();
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    c.push("T1", chunk(1));
    await settle();
    c.endStream("T1"); // a server-side unsubscribe, or rtc-node closing the stream
    await settle();
    expect(c.calls.filter((x) => x === "subscribe T1")).toHaveLength(2);
    c.push("T1", chunk(2));
    await settle();
    expect(h.frames.map((f) => f.first)).toEqual([1, 2]);
    expect(h.status).toEqual(["connected"]);
  });

  it("the stale-track race: pause and resume faster than the unsubscribe takes effect keeps the seat heard", async () => {
    const h = harness();
    h.port.lagUnsubscribe = true;
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    h.ingest.setAllowed(new Map()); // pause (or mute)
    h.ingest.setAllowed(new Map([["alice", G1]])); // resume, before LiveKit has applied the unsubscribe
    await settle();
    c.flushUnsubscribed(); // the late unsubscribe ends the resumed stream too
    await settle();
    c.push("T1", chunk(7));
    await settle();
    expect(h.frames.map((f) => f.first)).toEqual([7]);
    expect(c.openIterators("T1")).toBe(1);
    expect(h.status).toEqual(["connected"]);
  });

  it("a stream that ends while the role is no longer allowed or the track is gone is not restarted", async () => {
    const h = harness();
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    h.ingest.setAllowed(new Map());
    c.endStream("T1");
    await settle();
    expect(c.calls.filter((x) => x === "subscribe T1")).toHaveLength(1);
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    c.unpublish(A1, "T1");
    await settle();
    expect(c.calls.filter((x) => x === "subscribe T1")).toHaveLength(2);
  });

  it(`a stream that keeps ending with no frame is restarted at most ${MAX_TRACK_RESTARTS} times in a row, then the ingest reports failed`, async () => {
    const h = harness();
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    for (let i = 0; i < MAX_TRACK_RESTARTS; i++) { c.endStream("T1"); await settle(); }
    expect(h.status).toEqual(["connected"]);
    expect(c.calls.filter((x) => x === "subscribe T1")).toHaveLength(MAX_TRACK_RESTARTS + 1);
    c.endStream("T1");
    await settle();
    expect(h.status).toEqual(["connected", "failed"]);
    expect(h.state()).toBe("rejected");
  });

  it("a delivered frame resets the restart count (a long session with many short drops is not failed)", async () => {
    const h = harness();
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    for (let i = 0; i < 3 * MAX_TRACK_RESTARTS; i++) { c.endStream("T1"); await settle(); c.push("T1", chunk(i)); await settle(); }
    expect(h.status).toEqual(["connected"]);
    expect(h.frames).toHaveLength(3 * MAX_TRACK_RESTARTS);
  });

  it("a return() that waits for the pending read (like a real async generator) still lets the next subscription's frames through", async () => {
    const h = harness();
    h.port.initial = [mic(A1, "T1")];
    h.start();
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    const c = h.conn(0);
    expect(c.waitingIterators("T1")).toBe(1);
    h.ingest.setAllowed(new Map([["alice", G3]])); // the old loop's return() is queued behind its pending read
    h.ingest.setAllowed(new Map([["alice", G1]]));
    await settle();
    c.push("T1", chunk(5)); // the old pending read receives it too, and drops it (ended); the new loop delivers it once
    await settle();
    expect(h.frames.map((f) => [f.generation, f.first])).toEqual([[G1, 5]]);
  });
});
