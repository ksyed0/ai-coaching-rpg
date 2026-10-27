import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "./config";

// Sealed cookie: AES-256-GCM, token `keyId.nonce.ciphertext.tag` (base64url parts). The key id is authenticated as AAD so a token
// cannot be relabelled to another key; expiry lives inside the sealed payload so the browser cannot extend it.
type Keys = Config["cookieKeys"];

const MAX_TOKEN_CHARS = 4096;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function seal(payload: unknown, keys: Keys, now: number): string {
  const first = keys[0];
  if (!first) throw new Error("seal needs at least one key");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("seal payload must be an object");
  const expiresAt = (payload as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw new Error("seal payload needs a finite expiresAt");
  if (expiresAt <= now) throw new Error("seal payload is already expired");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", first.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(first.id, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const token = [first.id, nonce.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  // A cookie that unseal would refuse is a bug in the caller, not something to hand to a browser.
  if (token.length > MAX_TOKEN_CHARS) throw new Error("sealed token too large");
  return token;
}

function canonical(part: string): Buffer | null {
  const buf = Buffer.from(part, "base64url");
  return buf.toString("base64url") === part ? buf : null;
}

/** Null for anything that is not a live token sealed with one of `keys`. Never throws. */
export function unseal<T>(token: string, keys: Keys, now: number): T | null {
  try {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [id, n, c, t] = parts as [string, string, string, string];
    const key = keys.find((k) => k.id === id);
    if (!key) return null;
    // Canonical encoding only: Buffer.from skips junk and accepts other spellings, which would make one token many.
    const nonce = canonical(n);
    const tag = canonical(t);
    const ct = canonical(c);
    if (!nonce || !tag || !ct || nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const value: unknown = JSON.parse(plain);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return value as T;
  } catch {
    return null;
  }
}
