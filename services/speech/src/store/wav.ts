/** US-0073 (voice A2a): the stored audio format, 16 kHz mono 16-bit PCM. */
export const WAV_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
const CHANNELS = 1;
const BITS = 16;
const BLOCK_ALIGN = CHANNELS * (BITS / 8);

/** A canonical 44-byte RIFF/WAVE PCM file. Every field and sample is written little-endian explicitly (never the platform's order). */
export function wavBytes(pcm: Int16Array): Buffer {
  const dataBytes = pcm.length * BLOCK_ALIGN;
  const b = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // fmt chunk size for PCM
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(CHANNELS, 22);
  b.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  b.writeUInt32LE(WAV_SAMPLE_RATE * BLOCK_ALIGN, 28); // byte rate
  b.writeUInt16LE(BLOCK_ALIGN, 32);
  b.writeUInt16LE(BITS, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, WAV_HEADER_BYTES + i * 2);
  return b;
}

