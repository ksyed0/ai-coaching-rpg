import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { seal, unseal } from "../seal";

const mk = (id: string) => ({ id, key: randomBytes(32) });
const NOW = 1_000_000;
const payload = { sessionId: "s1", credential: "abc", expiresAt: NOW + 60_000 };

// Flip one bit of a base64url part at the byte level, so the change is real and not a padding artefact.
function tamper(token: string, part: number): string {
  const parts = token.split(".");
  const raw = Buffer.from(parts[part]!, "base64url");
  raw[0] = raw[0]! ^ 1;
  parts[part] = raw.toString("base64url");
  return parts.join(".");
}

describe("seal / unseal", () => {
  it("seal and unseal round-trip", () => {
    const keys = [mk("k1")];
    const token = seal(payload, keys, NOW);
    expect(token.split(".")).toHaveLength(4);
    expect(token.startsWith("k1.")).toBe(true);
    expect(unseal<typeof payload>(token, keys, NOW)).toEqual(payload);
  });

  it("does not put the payload in the clear", () => {
    expect(seal(payload, [mk("k1")], NOW)).not.toContain("abc");
  });

  it("uses a fresh nonce per seal", () => {
    const keys = [mk("k1")];
    expect(seal(payload, keys, NOW)).not.toBe(seal(payload, keys, NOW));
  });

  it("unseal returns null for a flipped byte, an expired payload and an unknown key id", () => {
    const keys = [mk("k1")];
    const token = seal(payload, keys, NOW);
    for (const part of [1, 2, 3]) expect(unseal(tamper(token, part), keys, NOW)).toBeNull();
    expect(unseal(token, keys, payload.expiresAt)).toBeNull();
    expect(unseal(token, keys, payload.expiresAt + 1)).toBeNull();
    expect(unseal(token, keys, payload.expiresAt - 1)).not.toBeNull();
    expect(unseal(token, [mk("other")], NOW)).toBeNull();
  });

  it("the key id is bound: relabelling a token with another id that holds the same key fails", () => {
    const shared = randomBytes(32);
    const token = seal(payload, [{ id: "k1", key: shared }], NOW);
    const relabelled = ["k2", ...token.split(".").slice(1)].join(".");
    expect(unseal(relabelled, [{ id: "k1", key: shared }, { id: "k2", key: shared }], NOW)).toBeNull();
  });

  it("a token sealed with one key does not open under another key of the same id", () => {
    const token = seal(payload, [mk("k1")], NOW);
    expect(unseal(token, [mk("k1")], NOW)).toBeNull();
  });

  it("a rotated key still opens a cookie sealed with the older key while newest seals", () => {
    const oldKey = mk("old");
    const newKey = mk("new");
    const oldToken = seal(payload, [oldKey], NOW);
    const rotated = [newKey, oldKey];
    expect(unseal<typeof payload>(oldToken, rotated, NOW)).toEqual(payload);
    expect(seal(payload, rotated, NOW).startsWith("new.")).toBe(true);
    // The retired key alone no longer opens new tokens.
    expect(unseal(seal(payload, rotated, NOW), [oldKey], NOW)).toBeNull();
  });

  it("tokens are not malleable: trailing junk, padding and the +/ spelling are refused", () => {
    const keys = [mk("k1")];
    const token = seal(payload, keys, NOW);
    const [id, n, c, t] = token.split(".") as [string, string, string, string];
    expect(unseal(token + "!", keys, NOW)).toBeNull();
    expect(unseal(`${id}.${n}.${c}.${t}=`, keys, NOW)).toBeNull();
    expect(unseal(`${id}.${n}.${c}!.${t}`, keys, NOW)).toBeNull();
    expect(unseal(`${id}.${n}!.${c}.${t}`, keys, NOW)).toBeNull();
    // Re-spell with the standard alphabet: same bytes, different text.
    const std = (x: string) => Buffer.from(x, "base64url").toString("base64");
    const respelled = [id, std(n), std(c), std(t)].join(".");
    if (respelled !== token) expect(unseal(respelled, keys, NOW)).toBeNull();
    // Non-canonical final character (spare low bits set) decodes to the same bytes.
    const alt = t.slice(0, -1) + "BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(t.slice(-1)) + 1) % 64];
    if (alt !== t && Buffer.from(alt, "base64url").equals(Buffer.from(t, "base64url"))) expect(unseal(`${id}.${n}.${c}.${alt}`, keys, NOW)).toBeNull();
  });

  it("returns null, never throws, for malformed input", () => {
    const keys = [mk("k1")];
    const token = seal(payload, keys, NOW);
    const [id, nonce, ct, tag] = token.split(".") as [string, string, string, string];
    const bad = ["", ".", "...", "a.b.c", "a.b.c.d.e", `${id}.${nonce}.${ct}`, `${id}.${nonce.slice(2)}.${ct}.${tag}`, `${id}.${nonce}.${ct}.${tag.slice(2)}`,
      `${id}.${nonce}.${ct}.${tag}.x`, `${id}.!!.${ct}.${tag}`, "x".repeat(5000), `${id}.${nonce}.${"A".repeat(5000)}.${tag}`];
    for (const t of bad) expect(unseal(t, keys, NOW)).toBeNull();
    expect(unseal(undefined as unknown as string, keys, NOW)).toBeNull();
    expect(unseal(token, [], NOW)).toBeNull();
  });

  it("refuses to seal a payload without a finite expiresAt, or a non-object", () => {
    const keys = [mk("k1")];
    for (const p of [{}, { expiresAt: "9" }, { expiresAt: Number.NaN }, { expiresAt: Infinity }, null, "x", 5, [1]]) expect(() => seal(p, keys, NOW)).toThrow();
    expect(() => seal(payload, [], NOW)).toThrow();
  });

  it("refuses to seal a payload that is already expired", () => {
    expect(() => seal({ expiresAt: NOW }, [mk("k1")], NOW)).toThrow();
  });

  it("refuses to seal a token larger than the unseal limit", () => {
    expect(() => seal({ expiresAt: NOW + 1, blob: "x".repeat(5000) }, [mk("k1")], NOW)).toThrow();
  });

  it("unseal returns null when the decrypted payload is not an object with expiresAt", () => {
    // Produce a validly authenticated token whose plaintext lacks expiresAt, via the raw primitive.
    const keys = [mk("k1")];
    const forged = forge("k1", keys[0]!.key, JSON.stringify({ a: 1 }));
    expect(unseal(forged, keys, NOW)).toBeNull();
    expect(unseal(forge("k1", keys[0]!.key, "not json"), keys, NOW)).toBeNull();
    expect(unseal(forge("k1", keys[0]!.key, JSON.stringify({ expiresAt: NOW + 5 })), keys, NOW)).not.toBeNull();
  });
});

function forge(id: string, key: Buffer, plaintext: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [id, nonce.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}
