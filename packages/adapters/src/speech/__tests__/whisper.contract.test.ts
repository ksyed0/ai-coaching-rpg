import { vi } from "vitest";
import { speechToTextContract, type ContractControl } from "../contract.js";
import { parseSttUrl, WhisperHttpSpeechToText } from "../whisper-http.js";
import type { Transcript } from "../types.js";
import { json, startFakeWhisper } from "./whisper-server.js";

// US-0070 (Task 12, AC-0402): the Whisper client passes the contract, against a stand-in server on loopback scripted by ContractControl.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
speechToTextContract("whisper-http", async () => {
  let answer: { text: string; extra?: Partial<Transcript> } = { text: "ok" };
  let failure: "unavailable" | "refused" | "hang" | null = null;
  let hanging: () => void = () => {};
  let hangSeen = Promise.resolve();
  const server = await startFakeWhisper((req, res) => {
    if (failure === "unavailable") return json(res, 503, { error: "down" });
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    if (failure === "refused") return json(res, 400, { error: "bad" });
    if (failure === "hang") { hanging(); return; }
    const segs = answer.extra?.noSpeechProb !== undefined || answer.extra?.avgLogprob !== undefined
      ? { segments: [{ start: 0, end: 1, no_speech_prob: answer.extra.noSpeechProb, avg_logprob: answer.extra.avgLogprob }] } : {};
    json(res, 200, { text: answer.text, ...segs });
  });
  const url = parseSttUrl(`http://127.0.0.1:${server.port}`);
  if (!url.ok) throw new Error(url.error);
  const control: ContractControl = {
    answer(text, extra) { failure = null; answer = { text, ...(extra ? { extra } : {}) }; },
    fail(kind) { failure = kind; if (kind === "hang") hangSeen = new Promise((r) => { hanging = r; }); },
    whenHanging: () => hangSeen,
  };
  return { stt: new WhisperHttpSpeechToText({ url: url.url }), control, close: () => server.close() };
});
