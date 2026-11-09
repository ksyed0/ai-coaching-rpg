import { describe, expect, it } from "vitest";
import { speechToTextContract, type ContractControl } from "../contract.js";
import { FakeSpeechToText } from "../fake.js";
import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError } from "../errors.js";
import type { SpeechSegment, Transcript } from "../types.js";

// US-0070 (Task 11, AC-0402): the fake passes the same contract suite as every other SpeechToText.
speechToTextContract("fake", async () => {
  let answer: Transcript = { text: "ok", durationMs: 0 };
  let failure: "unavailable" | "refused" | "hang" | null = null;
  let hanging: (() => void) | null = null;
  let hangSeen: Promise<void> = new Promise((r) => { hanging = r; });
  const stt = new FakeSpeechToText({
    healthy: () => failure !== "unavailable",
    script: () => {
      if (failure === "unavailable") return new SpeechUnavailableError();
      if (failure === "refused") return new SpeechRefusedError();
      if (failure === "hang") { hanging?.(); return new Promise<never>(() => {}); }
      return answer;
    },
  });
  const control: ContractControl = {
    answer(text, extra) { failure = null; answer = { text, durationMs: 0, ...extra }; },
    fail(kind) { failure = kind; if (kind === "hang") hangSeen = new Promise((r) => { hanging = r; }); },
    whenHanging: () => hangSeen,
  };
  return { stt, control, close: async () => {} };
});

const seg = (id = "s1"): SpeechSegment => ({ id, pcm: new Int16Array(160), sampleRate: 16000, deadline: 0 });

describe("FakeSpeechToText (US-0070)", () => {
  it("records segment ids in call order and passes the call number to the script", async () => {
    const seen: number[] = [];
    const stt = new FakeSpeechToText({ script: (s, n) => { seen.push(n); return { text: ` ${s.id} `, durationMs: 1 }; } });
    expect((await stt.transcribe(seg("a"))).text).toBe("a");
    expect((await stt.transcribe(seg("b"))).text).toBe("b");
    expect(stt.calls).toEqual(["a", "b"]);
    expect(seen).toEqual([0, 1]);
  });

  it("an Error from the script is thrown as it is; a promise is awaited", async () => {
    const stt = new FakeSpeechToText({ script: async (_s, n) => (n === 0 ? new SpeechRefusedError() : { text: "later", durationMs: 2 }) });
    await expect(stt.transcribe(seg())).rejects.toBeInstanceOf(SpeechRefusedError);
    expect(await stt.transcribe(seg())).toEqual({ text: "later", durationMs: 2 });
  });

  it("an already aborted signal is a timeout and the script is not called", async () => {
    const stt = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 0 }) });
    const ac = new AbortController();
    ac.abort();
    await expect(stt.transcribe(seg(), ac.signal)).rejects.toBeInstanceOf(SpeechTimeoutError);
    expect(stt.calls).toEqual([]);
  });

  it("warmUp does not count as a call and health defaults to true", async () => {
    const stt = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 0 }) });
    await stt.warmUp();
    expect(stt.calls).toEqual([]);
    expect(await stt.health()).toBe(true);
    expect(stt.warmUps).toBe(1);
  });
});
