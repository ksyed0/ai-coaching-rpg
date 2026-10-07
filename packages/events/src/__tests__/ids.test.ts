import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  CLIENT_ID_MAX_CHARS, FACILITATOR_ROLE_ID, FILE_SAFE_ID_PATTERN, PROTOTYPE_KEYS, SAFE_ID_MAX_CHARS, SAFE_ID_PATTERN, SCENARIO_ID_PATTERN,
  hasControlCharacters, isClientSuppliedId, isFileSafeId, isPrototypeKey, isReservedRoleId, isSafeId, isScenarioId, isValidSessionId,
} from "../index.js";

/** A small seeded generator, so a failing case is reproducible (no Math.random, no clock). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SAFE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const isSafeChar = (ch: string): boolean => SAFE_CHARS.includes(ch);

/** Pieces that must never appear in a name that reaches the file system. */
const HOSTILE = ["..", ".", "/", "\\", "../", "..\\", "a/../b", "/etc/passwd", "C:\\x", "%2e%2e", "%2f", "\0", "\n", "\r", "\t", " ", ":", "~", "*", "?", "<", ">", "|", '"', "'",
  ";", "$", "`", "\u202e", "\u200b", "\u00e9", "\uff41", "\ud83d\ude00", ".jsonl", ".lock", ".codes.json"];

describe("identifier rules: the shared module (US-0020, AC-0062)", () => {
  it("accepts exactly the safe characters for a session id: every UTF-16 code unit, one at a time", () => {
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      expect(isValidSessionId(`a${ch}`), `U+${c.toString(16)}`).toBe(isSafeChar(ch));
      expect(isValidSessionId(`${ch}a`), `U+${c.toString(16)}`).toBe(isSafeChar(ch));
      expect(isScenarioId(`a${ch}`), `U+${c.toString(16)}`).toBe(isSafeChar(ch) && ch === ch.toLowerCase() && !/[A-Z]/.test(ch));
    }
  });

  it("refuses every hostile piece alone, at either end and in the middle of a good name, for every rule that reaches a file", () => {
    for (const bad of HOSTILE) {
      for (const id of [bad, `ok${bad}`, `${bad}ok`, `ok${bad}ok`]) {
        expect(isValidSessionId(id), JSON.stringify(id)).toBe(false);
        expect(isSafeId(id), JSON.stringify(id)).toBe(false);
        expect(isFileSafeId(id), JSON.stringify(id)).toBe(false);
        expect(isScenarioId(id), JSON.stringify(id)).toBe(false);
      }
    }
  });

  it("refuses every pair of hostile pieces (1000+ generated names)", () => {
    let n = 0;
    for (const a of HOSTILE) for (const b of HOSTILE) { n++; expect(isValidSessionId(a + b), JSON.stringify(a + b)).toBe(false); }
    expect(n).toBeGreaterThan(1000);
  });

  it("is anchored at both ends: a trailing newline, a leading newline and an embedded NUL never pass", () => {
    for (const id of ["ok\n", "\nok", "ok\0", "\0ok", "ok\r\n", "ok\u2028"]) {
      expect(isValidSessionId(id)).toBe(false);
      expect(isFileSafeId(id)).toBe(false);
      expect(isScenarioId(id)).toBe(false);
    }
    expect(SAFE_ID_PATTERN.global || SAFE_ID_PATTERN.sticky || SCENARIO_ID_PATTERN.global || FILE_SAFE_ID_PATTERN.sticky).toBe(false); // a stateful regex would alternate verdicts
    for (let i = 0; i < 4; i++) expect(isValidSessionId("local")).toBe(true);
  });

  it("property: every id it accepts is a plain file name that stays in its directory, with every suffix the store adds", () => {
    const rnd = prng(20_261_007);
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const len = 1 + Math.floor(rnd() * 70);
      // mostly safe characters with a hostile piece sometimes spliced in
      let id = "";
      for (let k = 0; k < len; k++) id += SAFE_CHARS[Math.floor(rnd() * SAFE_CHARS.length)]!;
      if (rnd() < 0.5) { const at = Math.floor(rnd() * (id.length + 1)); id = id.slice(0, at) + HOSTILE[Math.floor(rnd() * HOSTILE.length)]! + id.slice(at); }
      if (!isValidSessionId(id)) continue;
      accepted++;
      for (const suffix of [".jsonl", ".lock", ".codes.json", ".20300102T030405Z.jsonl", ".codes.json.0123456789ab.tmp"]) {
        const name = id + suffix;
        expect(path.basename(name)).toBe(name);
        expect(path.join("/data/sessions", name)).toBe(`/data/sessions/${name}`);
        expect(name.startsWith(".")).toBe(false);
        expect(/[/\\\0]/.test(name)).toBe(false);
        expect(name.split(".").includes("")).toBe(false); // no empty segment, so never ".." or a hidden file
      }
      expect(id.length).toBeLessThanOrEqual(SAFE_ID_MAX_CHARS);
      expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
    }
    expect(accepted).toBeGreaterThan(500); // the property saw plenty of accepted ids, not just refusals
  });

  it("property: random strings over the safe alphabet are accepted up to 64 characters and refused past that", () => {
    const rnd = prng(7);
    for (let i = 0; i < 500; i++) {
      const len = 1 + Math.floor(rnd() * 130);
      let id = "";
      for (let k = 0; k < len; k++) id += SAFE_CHARS[Math.floor(rnd() * SAFE_CHARS.length)]!;
      expect(isValidSessionId(id)).toBe(len <= SAFE_ID_MAX_CHARS);
    }
    expect(isValidSessionId("")).toBe(false);
  });

  it("keeps the three families and their differences exactly", () => {
    // scenario: lower case, any length; file-safe: lower case, 1..64; safe/session: either case, 1..64
    expect([isScenarioId("a".repeat(500)), isFileSafeId("a".repeat(500)), isSafeId("a".repeat(500))]).toEqual([true, false, false]);
    expect([isScenarioId("Ab"), isFileSafeId("Ab"), isSafeId("Ab")]).toEqual([false, false, true]);
    expect([isScenarioId(""), isFileSafeId(""), isSafeId("")]).toEqual([false, false, false]);
    expect(isValidSessionId).not.toBe(isSafeId); // distinct names, one rule
    expect(isValidSessionId("Ab_9-")).toBe(isSafeId("Ab_9-"));
  });

  it("session ids are not reserved words: prototype keys and the facilitator id are plain, harmless file names (Map keys, never plain-object keys)", () => {
    for (const k of [...PROTOTYPE_KEYS, FACILITATOR_ROLE_ID]) expect(isValidSessionId(k)).toBe(true);
    expect([...PROTOTYPE_KEYS]).toEqual(["__proto__", "constructor", "prototype"]);
    expect(Object.isFrozen(PROTOTYPE_KEYS)).toBe(true);
  });

  it("reserved role ids: the facilitator and the prototype keys, nothing else", () => {
    for (const k of ["facilitator", "__proto__", "constructor", "prototype"]) expect(isReservedRoleId(k)).toBe(true);
    for (const k of ["Facilitator", "facilitator ", "toString", "hasOwnProperty", "proto", "guest", ""]) expect(isReservedRoleId(k)).toBe(false);
    expect(isPrototypeKey("facilitator")).toBe(false);
    expect(isPrototypeKey("__proto__")).toBe(true);
  });

  it("client-supplied ids: 1 to 128 characters with no control character (C0, DEL, C1)", () => {
    expect(CLIENT_ID_MAX_CHARS).toBe(128);
    expect(isClientSuppliedId("x".repeat(128))).toBe(true);
    expect(isClientSuppliedId("x".repeat(129))).toBe(false);
    expect(isClientSuppliedId("")).toBe(false);
    expect(isClientSuppliedId("a b.c/../é")).toBe(true); // the client does not decide what an id may contain beyond control characters: the server does
    for (let c = 0; c <= 0xffff; c++) {
      const control = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
      expect(hasControlCharacters(`a${String.fromCharCode(c)}b`), `U+${c.toString(16)}`).toBe(control);
    }
  });
});
