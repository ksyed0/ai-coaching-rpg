import net from "node:net";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 1): character-level validators for voice-ops. Every check walks the characters by code: the US-0020
 * guard allows a regular-expression character class with letters, digits and `_` only in packages/events/src/ids.ts, which voice-ops may
 * not import (it may import only `node:` built-ins and `@acr/adapters`).
 */

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isLower = (c: number): boolean => c >= 0x61 && c <= 0x7a;
const isUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;
const HYPHEN = 0x2d;
const UNDERSCORE = 0x5f;

/** Exactly `length` characters, each `0`-`9` or `a`-`f` (lower case only). */
export function isHex(v: string, length: number): boolean {
  if (v.length !== length) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (!isDigit(c) && !(c >= 0x61 && c <= 0x66)) return false; }
  return true;
}

/** 1 to 64 characters, each a letter, a digit, `_` or `-`: the same set as `isSafeId` in packages/events (STT_MODEL's parts). */
export function isSafeIdText(v: string): boolean {
  if (v.length < 1 || v.length > 64) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (!isDigit(c) && !isLower(c) && !isUpper(c) && c !== UNDERSCORE && c !== HYPHEN) return false; }
  return true;
}

/** 1 to `max` characters, each a lower-case letter, a digit or `-` (a DNS provider name). */
export function isLowerName(v: string, max: number): boolean {
  if (v.length < 1 || v.length > max) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (!isDigit(c) && !isLower(c) && c !== HYPHEN) return false; }
  return true;
}

/**
 * A DNS name the participants' browsers can be given a certificate for: 1 to 253 characters, at least two labels, each 1 to 63 letters,
 * digits and `-` that neither starts nor ends with `-`, the last label not all digits (so no IPv4 address), never `localhost` or a name
 * under it.
 */
export function isHostname(v: string): boolean {
  if (v.length < 1 || v.length > 253) return false;
  const labels = v.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (label.charCodeAt(0) === HYPHEN || label.charCodeAt(label.length - 1) === HYPHEN) return false;
    for (let i = 0; i < label.length; i++) { const c = label.charCodeAt(i); if (!isDigit(c) && !isLower(c) && !isUpper(c) && c !== HYPHEN) return false; }
  }
  const last = labels[labels.length - 1]!;
  let allDigits = true;
  for (let i = 0; i < last.length; i++) if (!isDigit(last.charCodeAt(i))) allDigits = false;
  if (allDigits) return false;
  return last.toLowerCase() !== "localhost";
}

/** A dotted-quad IPv4 address: four parts of 1 to 3 digits, no leading zero, each at most 255. */
export function parseIPv4(v: string): [number, number, number, number] | null {
  const parts = v.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (p.length < 1 || p.length > 3) return null;
    for (let i = 0; i < p.length; i++) if (!isDigit(p.charCodeAt(i))) return null;
    if (p.length > 1 && p.charCodeAt(0) === 0x30) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * A private LAN address: IPv4 10/8, 172.16/12 or 192.168/16, or IPv6 unique-local `fc00::/7`. Loopback and link-local are not private
 * here (a LAN client cannot reach them).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!net.isIPv6(ip)) return false;
  const first = ip.slice(0, ip.indexOf(":"));
  if (first.length < 1 || first.length > 4) return false; // "::..." starts with a zero group
  let h = 0;
  for (let i = 0; i < first.length; i++) {
    const c = first.toLowerCase().charCodeAt(i);
    const d = isDigit(c) ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : -1;
    if (d < 0) return false;
    h = h * 16 + d;
  }
  return (h & 0xfe00) === 0xfc00;
}
