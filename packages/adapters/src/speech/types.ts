/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.3): the speech-to-text seam. Any implementation (the fake, the local Whisper client, a later cloud
 * provider) passes `speechToTextContract`. Audio is 16 kHz mono 16-bit PCM; nothing here logs, and no error carries a URL, a body or a
 * transcript.
 */

/** One segment of one track, cut by the speech worker's segmenter. */
export type SpeechSegment = {
  /** The worker's segment id (file-safe). */
  id: string;
  pcm: Int16Array;
  sampleRate: 16000;
  /** The latest moment (absolute milliseconds on the caller's injected clock) by which its text is useful; the limiter enforces it. */
  deadline: number;
};

export type Transcript = {
  /** Trimmed; empty when nothing was heard. */
  text: string;
  /** How long the call took (milliseconds on the implementation's clock, never negative). */
  durationMs: number;
  /** The model's no-speech score (0..1), when the server reports one. */
  noSpeechProb?: number;
  /** The model's average token log-probability (duration-weighted), when the server reports one. */
  avgLogprob?: number;
};

export interface SpeechToText {
  /** Rejects with SpeechUnavailableError, SpeechTimeoutError (the signal aborted) or SpeechRefusedError, never another type. */
  transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript>;
  /** True when the server answers; never throws. */
  health(signal?: AbortSignal): Promise<boolean>;
  /** One throwaway request that absorbs the first-call cost (a model load); the text is ignored. Rejects like transcribe. */
  warmUp(signal?: AbortSignal): Promise<void>;
}
