/**
 * US-0070 test helper: deterministic synthetic signals at 16 kHz (no recorded audio anywhere in the tests). A tone is a 500 Hz sine (10
 * whole periods per 20 ms frame, so every full frame has the same RMS) whose RMS is `dbfs` below full scale.
 */
export const RATE = 16_000;
export const FRAME_SAMPLES = 320; // 20 ms

const samples = (ms: number): number => Math.round((ms * RATE) / 1000);

export function tone(ms: number, dbfs: number, startPhase = 0): Int16Array {
  const amp = Math.SQRT2 * 32768 * 10 ** (dbfs / 20);
  const out = new Int16Array(samples(ms));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 500 * (i + startPhase)) / RATE));
  return out;
}

export function silence(ms: number): Int16Array { return new Int16Array(samples(ms)); }

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The signal cut into whole 20 ms frames (a trailing partial frame is padded with silence). */
export function frames(pcm: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let o = 0; o < pcm.length; o += FRAME_SAMPLES) {
    const f = new Int16Array(FRAME_SAMPLES);
    f.set(pcm.subarray(o, Math.min(pcm.length, o + FRAME_SAMPLES)));
    out.push(f);
  }
  return out;
}
