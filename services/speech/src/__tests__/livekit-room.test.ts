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
    const conn = new RtcConn(room as never);
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
    return { rtc, room, conn, pub, participant, subscribed, read };
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
