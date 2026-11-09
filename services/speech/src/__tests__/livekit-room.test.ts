import { createRequire } from "node:module";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

// US-0071 (EPIC-0003 voice A1b, Task 7, R26): rtc-node's own logger (pino, level debug by default, some warnings quote an identity)
// must be silent before the worker opens a room. This loads the native library (glibc or macOS), like the worker with SPEECH_INGEST=livekit.
describe("the rtc-node logger (US-0071, A1b Task 7, R26)", () => {
  it("silenceRtcLogger sets the logger the library itself uses to silent", async () => {
    const { silenceRtcLogger } = await import("../ingest/livekit-room.js");
    const req = createRequire(import.meta.url);
    const dist = path.dirname(req.resolve("@livekit/rtc-node"));
    const room = req.cache[path.join(dist, "room.cjs")];
    expect(room, "the library's room module was loaded through the CommonJS build").toBeDefined();
    const used = room!.children.find((c) => c.filename === path.join(dist, "log.cjs"))?.exports as { log: { level: string } } | undefined;
    expect(used?.log.level).not.toBe("silent"); // the library's default (debug, or info with NODE_ENV=production): it would log
    silenceRtcLogger();
    expect(used!.log.level).toBe("silent");
    expect((req(path.join(dist, "log.cjs")) as { log: unknown }).log).toBe(used!.log);
  });
});

// Batch 3 review F2: RtcConn against a stand-in for rtc-node's Room (an EventEmitter with the same event names). The library's own enum
// values are used, so a renamed event fails here.
describe("RtcConn subscriptions (US-0071, A1b batch 3 review F2)", () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function setup() {
    const rtc = await import("@livekit/rtc-node");
    const { RtcConn } = await import("../ingest/livekit-room.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    /** Manual timers (A1b Task 18 D60): `fire()` runs every armed and not cancelled one. */
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
    const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    const conn = new RtcConn(room as never, { setTimer });
    const subscribed: boolean[] = [];
    const pub = { sid: "TR_1", kind: rtc.TrackKind.KIND_AUDIO, source: rtc.TrackSource.SOURCE_MICROPHONE, setSubscribed: (b: boolean) => { subscribed.push(b); } };
    const participant = { identity: "alice.g11111111", trackPublications: new Map([["TR_1", pub]]) };
    room.emit(rtc.RoomEvent.TrackPublished, pub, participant);
    /** Starts a read; reports whether (and how) it settled. */
    const read = () => {
      const r: { state: "pending" | "done" | "value" | "threw" } = { state: "pending" };
      void conn.frames("TR_1", 16000, 1)[Symbol.asyncIterator]().next().then((x) => { r.state = x.done ? "done" : "value"; }, () => { r.state = "threw"; });
      return r;
    };
    return { rtc, room, conn, pub, participant, subscribed, read, timers, fire };
  }

  it("after an unsubscribe, a new read waits for a fresh TrackSubscribed (never a stream on the old cached track)", async () => {
    const t = await setup();
    t.room.emit(t.rtc.RoomEvent.TrackSubscribed, { stale: true }, t.pub, t.participant); // the track as first subscribed
    t.conn.unsubscribe("TR_1");
    t.conn.subscribe("TR_1"); // a fast resume: rtc-node has not delivered TrackUnsubscribed yet
    const r = t.read();
    await settle();
    expect(r.state).toBe("pending"); // it waits; with the cached track it would have built an AudioStream on it at once
    t.room.emit(t.rtc.RoomEvent.TrackUnsubscribed, { stale: true }, t.pub, t.participant); // the late event
    await settle();
    expect(r.state).toBe("done"); // the read ends; the ingest subscribes again (livekit-ingest.test.ts)
    expect(t.subscribed).toEqual([false, true]);
  });

  it("TrackSubscriptionFailed settles a waiting read (it ends instead of hanging)", async () => {
    const t = await setup();
    t.conn.subscribe("TR_1");
    const r = t.read();
    await settle();
    expect(r.state).toBe("pending");
    t.room.emit(t.rtc.RoomEvent.TrackSubscriptionFailed, "TR_1", t.participant, "denied");
    await settle();
    expect(r.state).toBe("done");
  });

  // A1b Task 18 live finding D59: after a full reconnect (rtc-node: Reconnecting, TrackUnpublished, TrackPublished, Reconnected) a
  // subscription requested while the room was reconnecting never arrives: nothing re-sends it, and the seat stays deaf with no failure.
  it("Reconnected re-requests every subscription that has no track yet (one asked while reconnecting is lost otherwise)", async () => {
    const t = await setup();
    t.conn.subscribe("TR_1"); // asked during the reconnect: the server never answers it
    const r = t.read();
    t.room.emit(t.rtc.RoomEvent.Reconnected);
    await settle();
    expect(t.subscribed).toEqual([true, true]);
    expect(r.state).toBe("pending"); // the read still waits, now for the re-requested subscription
    t.room.emit(t.rtc.RoomEvent.TrackSubscribed, { fresh: true }, t.pub, t.participant);
    await settle();
    // The read took the delivered track (a stand-in object, which the real AudioStream refuses: "threw"); "done" would mean no track.
    expect(r.state).toBe("threw");
  });

  // A1b Task 18 live finding D60: a subscription the server refuses is never answered (LiveKit 1.13.11 sends neither TrackSubscribed
  // nor TrackSubscriptionFailed), so the read waited for ever and the seat stayed deaf with no failure surfaced.
  it("a read waiting for a subscription that is never answered ends after SUBSCRIBE_WAIT_MS (the ingest re-subscribes, bounded)", async () => {
    const t = await setup();
    const { SUBSCRIBE_WAIT_MS } = await import("../ingest/livekit-room.js");
    t.conn.subscribe("TR_1");
    const r = t.read();
    await settle();
    expect(r.state).toBe("pending");
    expect(t.timers.filter((x) => x.live).map((x) => x.ms)).toEqual([SUBSCRIBE_WAIT_MS]);
    t.fire();
    await settle();
    expect(r.state).toBe("done");
  });

  it("a stale subscribe timer never ends a later read, and a delivered track cancels its timer", async () => {
    const t = await setup();
    t.conn.subscribe("TR_1");
    const first = t.read();
    await settle();
    const stale = t.timers.splice(0); // keep the first read's timer for later
    t.conn.unsubscribe("TR_1"); // ends the first read
    t.conn.subscribe("TR_1");
    const second = t.read();
    await settle();
    expect(first.state).toBe("done");
    for (const x of stale) x.fn(); // the first read's timer (cancelled): even run late, it must not touch the second read
    await settle();
    expect(second.state).toBe("pending");
    t.room.emit(t.rtc.RoomEvent.TrackSubscribed, { fresh: true }, t.pub, t.participant);
    await settle();
    expect(second.state).toBe("threw"); // took the (stand-in) track
    expect(t.timers.filter((x) => x.live)).toEqual([]); // its own timer was cancelled by the delivery
  });

  it("Reconnected re-requests nothing already delivered, unsubscribed or gone", async () => {
    const t = await setup();
    t.conn.subscribe("TR_1");
    t.room.emit(t.rtc.RoomEvent.TrackSubscribed, { live: true }, t.pub, t.participant); // delivered
    const pub2 = { sid: "TR_2", kind: t.rtc.TrackKind.KIND_AUDIO, source: t.rtc.TrackSource.SOURCE_MICROPHONE, setSubscribed: (b: boolean) => { t.subscribed.push(b); } };
    const pub3 = { ...pub2, sid: "TR_3" };
    t.room.emit(t.rtc.RoomEvent.TrackPublished, pub2, t.participant);
    t.room.emit(t.rtc.RoomEvent.TrackPublished, pub3, t.participant);
    t.conn.subscribe("TR_2");
    t.conn.unsubscribe("TR_2"); // unsubscribed
    t.conn.subscribe("TR_3");
    t.room.emit(t.rtc.RoomEvent.TrackUnpublished, pub3, t.participant); // gone
    t.subscribed.length = 0;
    t.room.emit(t.rtc.RoomEvent.Reconnected);
    await settle();
    expect(t.subscribed).toEqual([]);
  });
});

describe("RtcConn listeners never throw into rtc-node's event dispatch (US-0071, A1b batch 3 review F5)", () => {
  it("a callback that throws inside TrackPublished is caught and routed to onDisconnected (the ingest then drops the room)", async () => {
    const rtc = await import("@livekit/rtc-node");
    const { RtcConn } = await import("../ingest/livekit-room.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    const conn = new RtcConn(room as never);
    let lost = 0;
    conn.onDisconnected(() => { lost++; });
    conn.onTrack(() => { throw new Error("a bug in a callback"); });
    conn.onTrackGone(() => { throw new Error("a bug in a callback"); });
    const pub = { sid: "TR_1", kind: rtc.TrackKind.KIND_AUDIO, source: rtc.TrackSource.SOURCE_MICROPHONE, setSubscribed: () => { throw new Error("ffi"); } };
    const participant = { identity: "alice.g11111111", trackPublications: new Map([["TR_1", pub]]) };
    expect(() => room.emit(rtc.RoomEvent.TrackPublished, pub, participant)).not.toThrow();
    expect(() => room.emit(rtc.RoomEvent.TrackUnpublished, pub, participant)).not.toThrow();
    expect(() => room.emit(rtc.RoomEvent.ParticipantDisconnected, participant)).not.toThrow();
    expect(lost).toBe(1); // once, however many listeners failed
    expect(() => room.emit(rtc.RoomEvent.Disconnected)).not.toThrow();
    expect(lost).toBe(1);
  });

  it("subscribe whose setSubscribed throws rethrows to the ingest (which retries, bounded) and never from an event", async () => {
    const rtc = await import("@livekit/rtc-node");
    const { RtcConn } = await import("../ingest/livekit-room.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    const conn = new RtcConn(room as never);
    const pub = { sid: "TR_1", kind: rtc.TrackKind.KIND_AUDIO, source: rtc.TrackSource.SOURCE_MICROPHONE, setSubscribed: () => { throw new Error("ffi"); } };
    room.emit(rtc.RoomEvent.TrackPublished, pub, { identity: "alice.g11111111", trackPublications: new Map([["TR_1", pub]]) });
    expect(() => conn.subscribe("TR_1")).toThrow("the LiveKit track could not be subscribed");
  });
});
