import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import type { PasswordHash } from "./types.js";

const N = 16384, R = 8, P = 1, KEYLEN = 64, SALT_BYTES = 16;
const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TEMP_LENGTH = 16;

function derive(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEYLEN, { N, r: R, p: P }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Salted scrypt (async, off the event loop). The plain text is never stored or returned. */
export async function hashPassword(plain: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt);
  return { salt: salt.toString("base64url"), hash: key.toString("base64url") };
}

export async function verifyPassword(plain: string, h: PasswordHash): Promise<boolean> {
  const salt = Buffer.from(h.salt, "base64url");
  const expected = Buffer.from(h.hash, "base64url");
  if (salt.length === 0 || expected.length !== KEYLEN) return false;
  const actual = await derive(plain, salt);
  return timingSafeEqual(actual, expected);
}

/** 16 characters, no look-alikes (no I, L, O, 0, 1). */
export function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_LENGTH; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}
