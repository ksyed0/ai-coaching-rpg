import { describe, expect, it, vi } from "vitest";
import { parseSttUrl, WhisperHttpSpeechToText } from "../whisper-http.js";

// US-0070 (Task 12, F1): the opt-in live check against a running whisper-server (STT_LIVE=1 and STT_URL). Records whether the answer
// carries the no-speech score and the average log-probability. Never runs in CI. The URL is never printed.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
describe.skipIf(process.env.STT_LIVE !== "1")("whisper-server live check (STT_LIVE=1)", () => {
  it("transcribes one second of silence and the answer parses", async () => {
    const p = parseSttUrl(process.env.STT_URL);
    if (!p.ok) throw new Error(p.error);
    const stt = new WhisperHttpSpeechToText({ url: p.url });
    expect(await stt.health()).toBe(true);
    await stt.warmUp(); // a cold model may load here (STT_COLD_TIMEOUT_MS in the worker)
    const t = await stt.transcribe({ id: "live", pcm: new Int16Array(16_000), sampleRate: 16000, deadline: Number.MAX_SAFE_INTEGER });
    expect(typeof t.text).toBe("string");
    console.log(`whisper live check: noSpeechProb ${t.noSpeechProb === undefined ? "absent" : "present"}, avgLogprob ${t.avgLogprob === undefined ? "absent" : "present"}`);
  });
});
