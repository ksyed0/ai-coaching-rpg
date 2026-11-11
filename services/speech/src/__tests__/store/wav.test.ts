import { describe, expect, it } from "vitest";
import { wavBytes } from "../../store/wav.js";

/** US-0073 (voice A2a, Task 6): a canonical 44-byte RIFF/WAVE PCM header, 16 kHz mono 16-bit, little-endian samples. */
describe("wavBytes", () => {
  it("test_header_fields_and_length", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const b = wavBytes(pcm);
    expect(b.length).toBe(44 + pcm.length * 2);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.readUInt32LE(4)).toBe(36 + pcm.length * 2);
    expect(b.toString("ascii", 8, 12)).toBe("WAVE");
    expect(b.toString("ascii", 12, 16)).toBe("fmt ");
    expect(b.readUInt32LE(16)).toBe(16); // PCM fmt chunk size
    expect(b.readUInt16LE(20)).toBe(1); // PCM
    expect(b.readUInt16LE(22)).toBe(1); // mono
    expect(b.readUInt32LE(24)).toBe(16000);
    expect(b.readUInt32LE(28)).toBe(32000); // byte rate
    expect(b.readUInt16LE(32)).toBe(2); // block align
    expect(b.readUInt16LE(34)).toBe(16); // bits per sample
    expect(b.toString("ascii", 36, 40)).toBe("data");
    expect(b.readUInt32LE(40)).toBe(pcm.length * 2);
  });
  it("test_samples_are_little_endian", () => {
    const b = wavBytes(Int16Array.from([0x0102, -2, 32767, -32768]));
    expect([...b.subarray(44)]).toEqual([0x02, 0x01, 0xfe, 0xff, 0xff, 0x7f, 0x00, 0x80]);
    expect(b.readInt16LE(46)).toBe(-2);
  });
  it("test_an_empty_segment_is_a_bare_header", () => {
    const b = wavBytes(new Int16Array(0));
    expect(b.length).toBe(44);
    expect(b.readUInt32LE(40)).toBe(0);
    expect(b.readUInt32LE(4)).toBe(36);
  });
  it("test_a_subarray_view_writes_only_its_own_samples", () => {
    const whole = Int16Array.from([9, 8, 7, 6]);
    const b = wavBytes(whole.subarray(1, 3));
    expect(b.length).toBe(48);
    expect([b.readInt16LE(44), b.readInt16LE(46)]).toEqual([8, 7]);
  });
});
