import { createRequire } from "node:module";
import path from "node:path";
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
