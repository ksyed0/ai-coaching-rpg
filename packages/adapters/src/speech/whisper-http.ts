import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, isSpeechError } from "./errors.js";
import type { SpeechSegment, SpeechToText, Transcript } from "./types.js";
import { encodeWav } from "./wav.js";

/** The largest answer read from the server; a larger one is refused (a transcript line is at most 2000 characters). */
export const MAX_WHISPER_BODY_BYTES = 256 * 1024;
/** How long a health check waits. */
export const WHISPER_HEALTH_TIMEOUT_MS = 2_000;
const STT_URL_RULE = "STT_URL is invalid: use http://127.0.0.1:<port>[/<path>] or http://[::1]:<port>[/<path>] (loopback only, no user, query or fragment)";

/**
 * US-0070 (spec 9, overview C9): the speech worker reaches whisper-server on loopback ONLY. `http:` with the host exactly `127.0.0.1` or
 * `[::1]`, an explicit port, an optional path prefix (whisper-server's `--request-path`), no user info, no query, no fragment. The error
 * names the setting and the rule, never the value.
 */
export function parseSttUrl(raw: string | undefined): { ok: true; url: URL } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: false, error: "STT_URL is required when voice is enabled (a loopback http address of the whisper-server)" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, error: STT_URL_RULE }; }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.port === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: STT_URL_RULE };
  }
  return { ok: true, url };
}

/**
 * US-0070 (spec 7.3): whisper.cpp's `whisper-server` over HTTP (Node's global fetch, FormData and Blob; no dependency). `transcribe` POSTs
 * the segment as a 16 kHz mono WAV to `<url>/inference` with `response_format=verbose_json` and `temperature=0.0`, reads at most 256 KiB,
 * and maps: a network failure or 5xx to SpeechUnavailableError, a 4xx, a redirect (never followed: audio never leaves the loopback
 * server) or an unreadable answer to SpeechRefusedError, an abort to SpeechTimeoutError. The no-speech score (max over segments) and the
 * average log-probability (duration-weighted) are taken only when the server reports finite numbers (F1: the layout is not verified yet).
 * The URL, the request and the answer are never logged and never in an error.
 */
export class WhisperHttpSpeechToText implements SpeechToText {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(o: { url: URL; fetch?: typeof fetch; now?: () => number }) {
    this.base = o.url.href.endsWith("/") ? o.url.href.slice(0, -1) : o.url.href;
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  async transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript> {
    if (signal?.aborted) throw new SpeechTimeoutError();
    const started = this.now();
    const form = new FormData();
    form.append("file", new Blob([encodeWav(seg.pcm, seg.sampleRate)], { type: "audio/wav" }), "segment.wav");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    try {
      const res = await this.fetchFn(`${this.base}/inference`, { method: "POST", body: form, redirect: "manual", ...(signal ? { signal } : {}) });
      if (res.status >= 500) { await discard(res); throw new SpeechUnavailableError({ status: res.status }); }
      if (res.status < 200 || res.status >= 300) { await discard(res); throw new SpeechRefusedError({ status: res.status }); }
      const body = await readLimited(res, MAX_WHISPER_BODY_BYTES);
      const parsed = parseAnswer(body);
      return { ...parsed, durationMs: Math.max(0, this.now() - started) };
    } catch (err) {
      if (signal?.aborted) throw new SpeechTimeoutError();
      if (isSpeechError(err)) throw err;
      throw new SpeechUnavailableError(); // a network error: the cause is dropped (it could quote the URL)
    }
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const timeout = AbortSignal.timeout(WHISPER_HEALTH_TIMEOUT_MS);
      const res = await this.fetchFn(`${this.base}/health`, { method: "GET", redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      await discard(res);
      return res.status === 200;
    } catch { return false; }
  }

  async warmUp(signal?: AbortSignal): Promise<void> {
    await this.transcribe({ id: "warmup", pcm: new Int16Array(16_000), sampleRate: 16000, deadline: Number.MAX_SAFE_INTEGER }, signal);
  }
}

async function discard(res: Response): Promise<void> { try { await res.body?.cancel(); } catch { /* nothing to free */ } }

/** The body as text, refused (SpeechRefusedError) beyond `limit` bytes; the stream is cancelled at once. */
async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await discard(res); throw new SpeechRefusedError({ status: res.status }); }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { try { await reader.cancel(); } catch { /* gone */ } throw new SpeechRefusedError({ status: res.status }); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Reads `{ text, segments?: [{ no_speech_prob, avg_logprob, start, end }] }` defensively; anything unusable is a SpeechRefusedError. */
function parseAnswer(body: string): Omit<Transcript, "durationMs"> {
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new SpeechRefusedError(); }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new SpeechRefusedError();
  const text = (json as { text?: unknown }).text;
  if (typeof text !== "string") throw new SpeechRefusedError();
  const out: Omit<Transcript, "durationMs"> = { text: text.trim() };
  const segments = (json as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) return out;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  let noSpeech: number | undefined;
  const lps: { lp: number; w: number | null }[] = [];
  for (const s of segments) {
    if (typeof s !== "object" || s === null) continue;
    const r = s as Record<string, unknown>;
    if (finite(r.no_speech_prob)) noSpeech = noSpeech === undefined ? r.no_speech_prob : Math.max(noSpeech, r.no_speech_prob);
    if (finite(r.avg_logprob)) {
      const w = finite(r.start) && finite(r.end) && r.end > r.start ? r.end - r.start : null;
      lps.push({ lp: r.avg_logprob, w });
    }
  }
  if (noSpeech !== undefined) out.noSpeechProb = noSpeech;
  if (lps.length > 0) {
    const weighted = lps.every((x) => x.w !== null);
    const sumW = weighted ? lps.reduce((a, x) => a + x.w!, 0) : lps.length;
    out.avgLogprob = lps.reduce((a, x) => a + x.lp * (weighted ? x.w! : 1), 0) / sumW;
  }
  return out;
}
