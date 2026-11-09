/**
 * US-0071 (EPIC-0003 voice A1b, Task 7, R10): cuts a track's audio into frames of exactly `samples` samples (320: 20 ms of 16 kHz mono,
 * the only size the segmenter takes), whatever size the source delivers, carrying the remainder to the next chunk. Every frame returned
 * is a fresh copy. One Reframer per track loop: a remainder never crosses from one track (or one subscription) into another.
 */
export class Reframer {
  private readonly buf: Int16Array;
  private fill = 0;

  constructor(private readonly samples: number) {
    if (!Number.isSafeInteger(samples) || samples <= 0) throw new RangeError("Reframer: the frame size must be a positive whole number");
    this.buf = new Int16Array(samples);
  }

  push(chunk: Int16Array): Int16Array[] {
    const out: Int16Array[] = [];
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(this.samples - this.fill, chunk.length - off);
      this.buf.set(chunk.subarray(off, off + take), this.fill);
      this.fill += take;
      off += take;
      if (this.fill === this.samples) { out.push(this.buf.slice()); this.fill = 0; }
    }
    return out;
  }
}
