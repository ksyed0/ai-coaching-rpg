import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, hashPassword, verifyPassword } from "../accounts/passwords.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

describe("accounts passwords", () => {
  it("test_passwords_hash_never_contains_plain", async () => {
    const plain = "correct horse battery";
    const h = await hashPassword(plain);
    expect(JSON.stringify(h)).not.toContain(plain);
    expect(Object.keys(h).sort()).toEqual(["hash", "salt"]);
    expect(h.salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h.hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("test_passwords_verify_accepts_right_rejects_wrong", async () => {
    const h = await hashPassword("right-password-1");
    expect(await verifyPassword("right-password-1", h)).toBe(true);
    expect(await verifyPassword("wrong-password-1", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
    expect(await verifyPassword("x", { salt: "", hash: "" })).toBe(false);
  });

  it("test_passwords_same_password_hashes_differ", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("test_passwords_temporary_password_has_16_chars_from_alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(16);
      for (const c of p) expect(ALPHABET).toContain(c);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});
