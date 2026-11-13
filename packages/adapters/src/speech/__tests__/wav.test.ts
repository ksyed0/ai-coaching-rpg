import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../wav.js";

// US-0070 (Task 12): 16-bit PCM mono WAV, written and read by hand (no dependency).
function rand(n: number, seed = 7): Int16Array {
  let x = seed;
  return new Int16Array(n).map(() => { x = (x * 1103515245 + 12345) & 0x7fffffff; return (x % 65536) - 32768; });
}

describe("WAV (US-0070)", () => {
  it("encode then decode is identity for random samples (including the extremes)", () => {
    const pcm = rand(4001);
    pcm[0] = -32768; pcm[1] = 32767; pcm[2] = 0;
    const out = decodeWav(encodeWav(pcm, 16000));
    expect(out.sampleRate).toBe(16000);
    expect(Array.from(out.pcm)).toEqual(Array.from(pcm));
    expect(decodeWav(encodeWav(new Int16Array(0), 16000)).pcm.length).toBe(0);
  });

  it("header fields are little-endian 16 kHz mono 16-bit", () => {
    const bytes = encodeWav(new Int16Array([1, -2, 3]), 16000);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
    expect(bytes.byteLength).toBe(44 + 6);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(-2);
  });

  it("skips an unknown chunk before the data", () => {
    const plain = encodeWav(new Int16Array([5, 6]), 16000);
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // "LIST", odd size 3 plus a pad byte
    const bytes = new Uint8Array([...plain.slice(0, 36), ...list, ...plain.slice(36)]);
    new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
    expect(Array.from(decodeWav(bytes).pcm)).toEqual([5, 6]);
  });

  it("a stereo or 8-bit file is refused, and so is a format other than PCM", () => {
    for (const [offset, value] of [[22, 2], [34, 8], [20, 3]] as const) {
      const bytes = encodeWav(new Int16Array([1, 2]), 16000);
      new DataView(bytes.buffer).setUint16(offset, value, true);
      expect(() => decodeWav(bytes)).toThrow(RangeError);
    }
  });

  it("a truncated file is refused (header, chunk header, data), and so is a file that is not RIFF/WAVE", () => {
    const bytes = encodeWav(new Int16Array([1, 2, 3, 4]), 16000);
    for (const n of [0, 10, 40, bytes.byteLength - 1]) expect(() => decodeWav(bytes.slice(0, n))).toThrow(RangeError);
    const notRiff = bytes.slice();
    notRiff[0] = 0x58;
    expect(() => decodeWav(notRiff)).toThrow(RangeError);
    const noFmt = new Uint8Array([...bytes.slice(0, 12), ...bytes.slice(36)]);
    expect(() => decodeWav(noFmt)).toThrow(RangeError);
    try { decodeWav(notRiff); } catch (err) { expect((err as Error).message).toBe("not a 16-bit PCM mono WAV file"); }
  });

  it("encode refuses a sample rate that is not a positive whole number", () => {
    expect(() => encodeWav(new Int16Array(1), 0)).toThrow(RangeError);
    expect(() => encodeWav(new Int16Array(1), 1.5)).toThrow(RangeError);
  });
});
