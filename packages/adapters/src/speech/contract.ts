import { describe, expect, it } from "vitest";
import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, isSpeechError } from "./errors.js";
import type { SpeechSegment, SpeechToText, Transcript } from "./types.js";

/**
 * US-0070 (AC-0402): how a contract run scripts the implementation under test. `answer` makes the next calls succeed with `text`;
 * `fail` makes them fail: `unavailable` (no server, or 5xx; health is false), `refused` (4xx or an unreadable answer) or `hang` (the
 * request never gets an answer). `whenHanging` resolves once a hung request has reached the implementation's server, so the test can
 * abort it without any real waiting.
 */
export type ContractControl = {
  answer(text: string, extra?: Partial<Transcript>): void;
  fail(kind: "unavailable" | "refused" | "hang"): void;
  whenHanging(): Promise<void>;
};

const seg = (samples = 16_000): SpeechSegment => ({ id: "contract", pcm: new Int16Array(samples).map((_, i) => Math.round(8000 * Math.sin(i / 8))), sampleRate: 16000, deadline: Number.MAX_SAFE_INTEGER });

/** The one suite every SpeechToText passes (the fake, the Whisper client, the limiter around either). */
export function speechToTextContract(name: string, make: () => Promise<{ stt: SpeechToText; control: ContractControl; close(): Promise<void> }>): void {
  describe(`SpeechToText contract: ${name}`, () => {
    const withImpl = async (fn: (i: { stt: SpeechToText; control: ContractControl }) => Promise<void>) => {
      const i = await make();
      try { await fn(i); } finally { await i.close(); }
    };
    const failure = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return "resolved"; } catch (err) { return err; } };

    it("returns the scripted text and a non-negative durationMs", () => withImpl(async ({ stt, control }) => {
      control.answer("We can ship in May.");
      const t = await stt.transcribe(seg());
      expect(t.text).toBe("We can ship in May.");
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }));

    it("the text is a string with no leading or trailing whitespace", () => withImpl(async ({ stt, control }) => {
      control.answer("  \n padded words\t \n");
      const t = await stt.transcribe(seg());
      expect(typeof t.text).toBe("string");
      expect(t.text).toBe("padded words");
    }));

    it("empty audio (0 samples) gives text \"\" or a SpeechRefusedError, never a throw of another type", () => withImpl(async ({ stt, control }) => {
      control.answer("");
      const r = await failure(stt.transcribe(seg(0)).then((t) => t.text));
      if (r !== "resolved") expect(r).toBeInstanceOf(SpeechRefusedError);
    }));

    it("unavailable gives SpeechUnavailableError", () => withImpl(async ({ stt, control }) => {
      control.fail("unavailable");
      expect(await failure(stt.transcribe(seg()))).toBeInstanceOf(SpeechUnavailableError);
    }));

    it("refused gives SpeechRefusedError", () => withImpl(async ({ stt, control }) => {
      control.fail("refused");
      expect(await failure(stt.transcribe(seg()))).toBeInstanceOf(SpeechRefusedError);
    }));

    it("a hang past the deadline gives SpeechTimeoutError once the signal aborts (no real waiting)", () => withImpl(async ({ stt, control }) => {
      control.fail("hang");
      const ac = new AbortController();
      const p = failure(stt.transcribe(seg(), ac.signal));
      await control.whenHanging();
      ac.abort();
      expect(await p).toBeInstanceOf(SpeechTimeoutError);
    }));

    it("an aborted signal gives SpeechTimeoutError", () => withImpl(async ({ stt, control }) => {
      control.answer("never seen");
      const ac = new AbortController();
      ac.abort();
      expect(await failure(stt.transcribe(seg(), ac.signal))).toBeInstanceOf(SpeechTimeoutError);
    }));

    it("health() is true when up and false when unavailable, and never throws", () => withImpl(async ({ stt, control }) => {
      control.answer("ok");
      expect(await stt.health()).toBe(true);
      control.fail("unavailable");
      expect(await stt.health()).toBe(false);
    }));

    it("every failure is one of the three speech errors", () => withImpl(async ({ stt, control }) => {
      for (const kind of ["unavailable", "refused"] as const) {
        control.fail(kind);
        expect(isSpeechError(await failure(stt.transcribe(seg())))).toBe(true);
      }
    }));
  });
}
