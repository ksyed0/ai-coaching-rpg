/**
 * US-0070: 16-bit PCM mono WAV, written and read by hand (about 40 lines, no dependency). Little-endian RIFF: a `fmt ` chunk with format 1
 * (PCM), 1 channel and 16 bits per sample, then a `data` chunk; other chunks (LIST ...) are skipped. Anything else is a RangeError with
 * one fixed sentence.
 */
const NOT_WAV = "not a 16-bit PCM mono WAV file";

export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError("the sample rate must be a positive whole number");
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

export function decodeWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new RangeError(NOT_WAV);
  let sampleRate: number | null = null;
  let o = 12;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (body + size > bytes.byteLength) throw new RangeError(NOT_WAV); // truncated
    if (id === "fmt ") {
      if (size < 16 || v.getUint16(body, true) !== 1 || v.getUint16(body + 2, true) !== 1 || v.getUint16(body + 14, true) !== 16) throw new RangeError(NOT_WAV);
      sampleRate = v.getUint32(body + 4, true);
      if (sampleRate === 0) throw new RangeError(NOT_WAV);
    } else if (id === "data") {
      if (sampleRate === null || size % 2 !== 0) throw new RangeError(NOT_WAV);
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(body + i * 2, true);
      return { pcm, sampleRate };
    }
    o = body + size + (size % 2); // chunks are padded to an even size
  }
  throw new RangeError(NOT_WAV);
}
