import { createRequire } from "node:module";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

// US-0071 (EPIC-0003 voice A1b, Task 7, R26): rtc-node's own logger (pino, level debug by default, some warnings quote an identity)
// must be silent before the worker opens a room. This loads the native library (glibc or macOS), like the worker with SPEECH_INGEST=livekit.
describe("the rtc-node logger (US-0071, A1b Task 7, R26)", () => {
  it("silenceRtcLogger sets the logger the library itself uses to silent", async () => {
    const { silenceRtcLogger } = await import("../ingest/livekit-room-native.js");
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
// values are used (the native module's `rtcBindings`), so a renamed event fails here.
describe("RtcConn subscriptions (US-0071, A1b batch 3 review F2)", () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function setup() {
    const rtc = await import("@livekit/rtc-node");
    const { RtcConn } = await import("../ingest/livekit-room.js");
    const { rtcBindings } = await import("../ingest/livekit-room-native.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    /** Manual timers (A1b Task 18 D60): `fire()` runs every armed and not cancelled one. */
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
    const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    const conn = new RtcConn(room as never, rtcBindings, { setTimer });
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
    const { rtcBindings } = await import("../ingest/livekit-room-native.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    const conn = new RtcConn(room as never, rtcBindings);
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
    const { rtcBindings } = await import("../ingest/livekit-room-native.js");
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => undefined });
    const conn = new RtcConn(room as never, rtcBindings);
    const pub = { sid: "TR_1", kind: rtc.TrackKind.KIND_AUDIO, source: rtc.TrackSource.SOURCE_MICROPHONE, setSubscribed: () => { throw new Error("ffi"); } };
    room.emit(rtc.RoomEvent.TrackPublished, pub, { identity: "alice.g11111111", trackPublications: new Map([["TR_1", pub]]) });
    expect(() => conn.subscribe("TR_1")).toThrow("the LiveKit track could not be subscribed");
  });
});

// Review finding 4 (coverage honesty): RtcConn is measured; only the native wiring (livekit-room-native.ts) is excluded. These cover
// what the stand-in Room above cannot reach with the real AudioStream: the frame format filter, the replay of tracks already in the
// room, the kind/source mapping, and the waiting reads ended by Disconnected and by our own disconnect.
describe("RtcConn with stand-in bindings (US-0071, A1b review finding 4)", () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  type Frame = { sampleRate: number; channels: number; data: Int16Array };
  async function setup(frames: Frame[] = []) {
    const rtc = await import("@livekit/rtc-node");
    const { RtcConn } = await import("../ingest/livekit-room.js");
    const opened: { track: unknown; o: unknown }[] = [];
    const bindings = {
      RoomEvent: rtc.RoomEvent, TrackKind: rtc.TrackKind, TrackSource: rtc.TrackSource,
      audioStream: (track: unknown, o: unknown) => { opened.push({ track, o }); return (async function* () { yield* frames; })(); },
    };
    let disconnects = 0;
    const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), disconnect: async () => { disconnects++; } });
    const timers: (() => void)[] = [];
    const conn = new RtcConn(room as never, bindings as never, { setTimer: () => () => { timers.push(() => undefined); } });
    const pub = (sid: string | undefined, kind = rtc.TrackKind.KIND_AUDIO, source = rtc.TrackSource.SOURCE_MICROPHONE) =>
      ({ sid, kind, source, setSubscribed: () => undefined });
    return { rtc, room, conn, opened, pub, disconnects: () => disconnects };
  }

  it("frames yields only 16 kHz mono frames from an AudioStream opened on the subscribed track", async () => {
    const good = new Int16Array([1, 2, 3]);
    const t = await setup([
      { sampleRate: 16000, channels: 1, data: good },
      { sampleRate: 48000, channels: 1, data: new Int16Array([9]) },
      { sampleRate: 16000, channels: 2, data: new Int16Array([8]) },
    ]);
    const p = t.pub("TR_1");
    t.room.emit(t.rtc.RoomEvent.TrackPublished, p, { identity: "alice.g11111111", trackPublications: new Map([["TR_1", p]]) });
    t.conn.subscribe("TR_1");
    const track = { sid: "TR_1" };
    t.room.emit(t.rtc.RoomEvent.TrackSubscribed, track, p, {});
    const got: Int16Array[] = [];
    for await (const f of t.conn.frames("TR_1", 16000, 1)) got.push(f);
    expect(got).toEqual([good]);
    expect(t.opened).toEqual([{ track, o: { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 } }]);
  });

  it("onTrack replays tracks already in the room and maps kind and source (audio microphone, video, unknown, other)", async () => {
    const t = await setup();
    const mic = t.pub("TR_A");
    const cam = t.pub("TR_V", t.rtc.TrackKind.KIND_VIDEO, t.rtc.TrackSource.SOURCE_CAMERA);
    const odd = t.pub("TR_U", t.rtc.TrackKind.KIND_UNKNOWN, t.rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO);
    const nosid = t.pub(undefined);
    t.room.remoteParticipants.set("alice.g11111111", { identity: "alice.g11111111", trackPublications: new Map<string, unknown>([["a", mic], ["v", cam], ["u", odd], ["n", nosid]]) });
    const seen: unknown[] = [];
    t.conn.onTrack((x) => seen.push(x));
    expect(seen).toEqual([
      { identity: "alice.g11111111", trackSid: "TR_A", kind: "audio", source: "microphone" },
      { identity: "alice.g11111111", trackSid: "TR_V", kind: "video", source: "other" },
      { identity: "alice.g11111111", trackSid: "TR_U", kind: "unknown", source: "other" },
    ]);
  });

  it("events without a track sid are ignored, and a gone track is reported to onTrackGone", async () => {
    const t = await setup();
    const gone: unknown[] = [];
    t.conn.onTrackGone((x) => gone.push(x));
    const p = t.pub(undefined);
    expect(() => t.room.emit(t.rtc.RoomEvent.TrackSubscribed, {}, p, {})).not.toThrow();
    expect(() => t.room.emit(t.rtc.RoomEvent.TrackUnsubscribed, {}, p, {})).not.toThrow();
    t.room.emit(t.rtc.RoomEvent.TrackUnpublished, p, { identity: "alice.g11111111" });
    expect(gone).toEqual([]);
    const q = t.pub("TR_1");
    t.room.emit(t.rtc.RoomEvent.TrackPublished, q, { identity: "alice.g11111111", trackPublications: new Map() });
    t.room.emit(t.rtc.RoomEvent.ParticipantDisconnected, { identity: "alice.g11111111", trackPublications: new Map([["TR_1", q]]) });
    expect(gone).toEqual([{ identity: "alice.g11111111", trackSid: "TR_1" }]);
  });

  it("Disconnected ends a waiting read and reports the room lost once", async () => {
    const t = await setup();
    let lost = 0;
    t.conn.onDisconnected(() => { lost++; });
    t.conn.onDisconnected(() => { throw new Error("a bug in a callback"); }); // never escapes
    const it = t.conn.frames("TR_1", 16000, 1)[Symbol.asyncIterator]();
    const next = it.next();
    await settle();
    expect(() => t.room.emit(t.rtc.RoomEvent.Disconnected)).not.toThrow();
    expect(await next).toEqual({ done: true, value: undefined });
    t.room.emit(t.rtc.RoomEvent.Disconnected);
    expect(lost).toBe(1);
  });

  it("our own disconnect ends a waiting read, closes the room and is never reported as lost", async () => {
    const t = await setup();
    let lost = 0;
    t.conn.onDisconnected(() => { lost++; });
    const next = t.conn.frames("TR_1", 16000, 1)[Symbol.asyncIterator]().next();
    await settle();
    await t.conn.disconnect();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(t.disconnects()).toBe(1);
    t.room.emit(t.rtc.RoomEvent.Disconnected);
    expect(lost).toBe(0);
  });
});
