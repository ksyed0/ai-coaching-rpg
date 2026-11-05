/**
 * Linear-time tests without a stopwatch bound.
 *
 * An absolute "finishes within N ms" assertion is not a test of complexity: coverage instrumentation, a busy machine or a slow CI
 * runner make the same code several times slower. What distinguishes a linear implementation from a quadratic one is how the time
 * GROWS with the input, so `expectLinear` measures the same operation at a small and at a larger size (best of several runs, after
 * a warm-up) and asserts that the larger run cost far less than a quadratic implementation would (factor squared). The absolute cap
 * is only there to turn a hang into a failure.
 */
export type ScalingOptions = {
  /** Input size multiplier for the small run (the work receives it as its argument). Default 1. */
  small?: number;
  /** How much bigger the large run is. Default 8 (a quadratic implementation costs 64x). */
  factor?: number;
  /** The large run may cost at most this many times the small run. Default 30, which a quadratic implementation (factor squared) still violates. */
  maxRatio?: number;
  /** Runs per size; the best one counts, which discards one-off scheduler and GC pauses. Default 3. */
  runs?: number;
  /** Absolute cap in ms for the large run: so generous that it only catches hangs. Default 60 000. */
  capMs?: number;
  /** Time floor in ms under which a measurement is not trusted (clock granularity): the ratio is taken against this at least. Default 0.25. */
  floorMs?: number;
};

export type ScalingResult = { smallMs: number; largeMs: number; ratio: number };

const best = (work: (scale: number) => void, scale: number, runs: number): number => {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    work(scale);
    min = Math.min(min, performance.now() - t0);
  }
  return min;
};

/** Run `work(scale)` at `small` and `small * factor`; returns the measurements and throws when the growth is super-linear or the cap is hit. */
export function expectLinear(work: (scale: number) => void, opts: ScalingOptions = {}): ScalingResult {
  const { small = 1, factor = 8, maxRatio = 30, runs = 3, capMs = 60_000, floorMs = 0.25 } = opts;
  if (maxRatio >= factor * factor) throw new Error("expectLinear: maxRatio must be below factor squared or a quadratic implementation passes");
  work(small); work(small * factor); // warm-up: JIT, regex compilation, lazy imports
  const smallMs = best(work, small, runs);
  const largeMs = best(work, small * factor, runs);
  const ratio = largeMs / Math.max(smallMs, floorMs);
  if (process.env.SCALING_DEBUG) process.stderr.write(`scaling ${smallMs.toFixed(2)} -> ${largeMs.toFixed(2)} ms, ratio ${ratio.toFixed(1)}\n`);
  const shown = `${smallMs.toFixed(2)} ms at ${small}x, ${largeMs.toFixed(2)} ms at ${small * factor}x`;
  if (largeMs > capMs) throw new Error(`not finishing in a sane time: ${shown}`);
  if (ratio >= maxRatio) throw new Error(`super-linear growth: ${shown}, ratio ${ratio.toFixed(1)} >= ${maxRatio} (a linear implementation stays near ${factor})`);
  return { smallMs, largeMs, ratio };
}
