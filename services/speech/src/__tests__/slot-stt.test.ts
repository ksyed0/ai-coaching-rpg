import { describe, expect, it } from "vitest";
import { FakeSpeechToText, SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, speechToTextContract, type ContractControl, type SpeechSegment, type Transcript } from "@acr/adapters";
import { SlotSpeechToText } from "../slot-stt.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 6, AC-0409): the worker's half of the global speech-to-text budget. Every inner transcription (and
 * the warm-up) runs only inside a slot control granted; the grants are driven by hand here (no real time).
 */
const seg = (id = "s1"): SpeechSegment => ({ id, pcm: new Int16Array(160), sampleRate: 16000, deadline: Number.MAX_SAFE_INTEGER });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness(script: () => Transcript | Error | Promise<Transcript | Error> = () => ({ text: "ok", durationMs: 1 })) {
  const log: string[] = [];
  let n = 0;
  const inner = new FakeSpeechToText({ script: () => { log.push("inner"); return script(); } });
  const stt = new SlotSpeechToText(inner, {
    request: (slot) => log.push(`request ${slot}`), release: (slot) => log.push(`release ${slot}`),
    newSlot: () => (++n).toString(16).padStart(16, "0"),
  });
  return { stt, inner, log, slot: (i: number) => i.toString(16).padStart(16, "0") };
}

describe("SlotSpeechToText (US-0071, A1b Task 6)", () => {
  it("transcribe waits for the grant before calling inner", async () => {
    const h = harness();
    const p = h.stt.transcribe(seg());
    await settle();
    expect(h.log).toEqual([`request ${h.slot(1)}`]);
    h.stt.granted(h.slot(1));
    expect((await p).text).toBe("ok");
    expect(h.log).toEqual([`request ${h.slot(1)}`, "inner", `release ${h.slot(1)}`]);
  });

  it("release is sent after success and after failure", async () => {
    const h = harness(() => new SpeechUnavailableError());
    const p = h.stt.transcribe(seg());
    h.stt.granted(h.slot(1));
    await expect(p).rejects.toBeInstanceOf(SpeechUnavailableError);
    expect(h.log).toEqual([`request ${h.slot(1)}`, "inner", `release ${h.slot(1)}`]);
  });

  it("an abort while waiting sends release and rejects SpeechTimeoutError without calling inner", async () => {
    const h = harness();
    const ac = new AbortController();
    const p = h.stt.transcribe(seg(), ac.signal);
    await settle();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(SpeechTimeoutError);
    expect(h.log).toEqual([`request ${h.slot(1)}`, `release ${h.slot(1)}`]);
    h.stt.granted(h.slot(1)); // the grant crossed the release: given back, never used
    await settle();
    expect(h.inner.calls).toEqual([]);
    expect(h.log.at(-1)).toBe(`release ${h.slot(1)}`);
  });

  it("an already aborted signal asks for no slot", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(h.stt.transcribe(seg(), ac.signal)).rejects.toBeInstanceOf(SpeechTimeoutError);
    expect(h.log).toEqual([]);
  });

  it("an abort while inner runs still releases the slot once", async () => {
    let hang!: () => void;
    const h = harness(() => new Promise((r) => { hang = () => r({ text: "late", durationMs: 1 }); }));
    const ac = new AbortController();
    const p = h.stt.transcribe(seg(), ac.signal);
    h.stt.granted(h.slot(1));
    await settle();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(SpeechTimeoutError);
    hang();
    await settle();
    expect(h.log.filter((l) => l.startsWith("release"))).toEqual([`release ${h.slot(1)}`]);
  });

  it("warmUp takes a slot too", async () => {
    const h = harness();
    const p = h.stt.warmUp();
    await settle();
    expect(h.inner.warmUps).toBe(0);
    h.stt.granted(h.slot(1));
    await p;
    expect(h.inner.warmUps).toBe(1);
    expect(h.log).toEqual([`request ${h.slot(1)}`, `release ${h.slot(1)}`]);
  });

  it("health takes no slot", async () => {
    const h = harness();
    expect(await h.stt.health()).toBe(true);
    expect(h.log).toEqual([]);
  });

  it("a grant nobody waits for is given back at once", async () => {
    const h = harness();
    h.stt.granted("ffffffffffffffff");
    expect(h.log).toEqual(["release ffffffffffffffff"]);
  });

  it("two calls get two slots, granted in any order", async () => {
    const h = harness();
    const p1 = h.stt.transcribe(seg("a"));
    const p2 = h.stt.transcribe(seg("b"));
    await settle();
    h.stt.granted(h.slot(2));
    await p2;
    expect(h.inner.calls).toEqual(["b"]);
    h.stt.granted(h.slot(1));
    await p1;
    expect(h.inner.calls).toEqual(["b", "a"]);
  });
});

// The slot wrapper passes the same contract as every other SpeechToText, with a control that grants every slot at once.
speechToTextContract("slot(fake)", async () => {
  let answer: Transcript = { text: "ok", durationMs: 0 };
  let failure: "unavailable" | "refused" | "hang" | null = null;
  let hanging: (() => void) | null = null;
  let hangSeen: Promise<void> = new Promise((r) => { hanging = r; });
  const inner = new FakeSpeechToText({
    healthy: () => failure !== "unavailable",
    script: () => {
      if (failure === "unavailable") return new SpeechUnavailableError();
      if (failure === "refused") return new SpeechRefusedError();
      if (failure === "hang") { hanging?.(); return new Promise<never>(() => {}); }
      return answer;
    },
  });
  let n = 0;
  const holder: { stt?: SlotSpeechToText } = {};
  const stt = new SlotSpeechToText(inner, {
    request: (slot) => { queueMicrotask(() => holder.stt!.granted(slot)); }, release: () => {},
    newSlot: () => (++n).toString(16).padStart(16, "0"),
  });
  holder.stt = stt;
  const control: ContractControl = {
    answer(text, extra) { failure = null; answer = { text, durationMs: 0, ...extra }; },
    fail(kind) { failure = kind; if (kind === "hang") hangSeen = new Promise((r) => { hanging = r; }); },
    whenHanging: () => hangSeen,
  };
  return { stt, control, close: async () => {} };
});
