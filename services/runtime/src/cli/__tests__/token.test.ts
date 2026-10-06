import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOKEN_FILE_MAX_BYTES, plainTokenWarning, readTokenFile, resolveFacilitatorToken, type TokenDeps } from "../token.js";

const TOKEN = "file-token-0123456789abcdef";
const deps = (o: Partial<TokenDeps> = {}): TokenDeps => ({
  env: {}, readFile: () => { throw new Error("unexpected read"); }, fileMode: () => 0o600, isTTY: false, promptHidden: async () => { throw new Error("unexpected prompt"); }, ...o,
});

describe("resolveFacilitatorToken", () => {
  it("uses FACILITATOR_TOKEN first, ahead of a file and the prompt", async () => {
    const r = await resolveFacilitatorToken(deps({ env: { FACILITATOR_TOKEN: TOKEN }, tokenFile: "/f", isTTY: true }));
    expect(r).toEqual({ ok: true, token: TOKEN, warnings: [] });
  });
  it("rejects an invalid env token without showing it", async () => {
    const r = await resolveFacilitatorToken(deps({ env: { FACILITATOR_TOKEN: "short" } }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("short\"");
    expect(!r.ok && r.error).toContain("FACILITATOR_TOKEN");
  });
  it("reads a token file, trims the final newline and warns when others can read it", async () => {
    const ok = await resolveFacilitatorToken(deps({ tokenFile: "/f", readFile: () => TOKEN + "\n" }));
    expect(ok).toEqual({ ok: true, token: TOKEN, warnings: [] });
    const loose = await resolveFacilitatorToken(deps({ tokenFile: "/f", readFile: () => TOKEN, fileMode: () => 0o644 }));
    expect(loose.ok && loose.warnings[0]).toMatch(/readable by other users \(mode 644\)/);
    expect(loose.ok && loose.warnings.join()).not.toContain(TOKEN);
    const group = await resolveFacilitatorToken(deps({ tokenFile: "/f", readFile: () => TOKEN, fileMode: () => 0o640 }));
    expect(group.ok && group.warnings.length).toBe(1);
  });
  it("fails on an unreadable or malformed file without showing its content", async () => {
    const missing = await resolveFacilitatorToken(deps({ tokenFile: "/nope", readFile: () => { throw new Error("ENOENT /nope"); } }));
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("cannot read the --token-file") });
    const bad = await resolveFacilitatorToken(deps({ tokenFile: "/f", readFile: () => "two words here 1234567890" }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("two words");
  });
  it("prompts (hidden) on a terminal when nothing else is given; blank means no token", async () => {
    const prompt = vi.fn(async () => `${TOKEN}\n`);
    expect(await resolveFacilitatorToken(deps({ isTTY: true, promptHidden: prompt }))).toEqual({ ok: true, token: TOKEN, warnings: [] });
    expect(prompt).toHaveBeenCalledOnce();
    expect(await resolveFacilitatorToken(deps({ isTTY: true, promptHidden: async () => "" }))).toEqual({ ok: true, token: undefined, warnings: [] });
    const bad = await resolveFacilitatorToken(deps({ isTTY: true, promptHidden: async () => "tiny" }));
    expect(bad.ok).toBe(false);
  });
  it("never prompts without a terminal: no token", async () => {
    expect(await resolveFacilitatorToken(deps())).toEqual({ ok: true, token: undefined, warnings: [] });
  });
});

describe("readTokenFile (review M7)", () => {
  it("reads a small file and refuses one over 1 KiB without reading it all", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "acr-tokfile-"));
    try {
      writeFileSync(path.join(dir, "ok"), "file-token-0123456789abcdef\n");
      expect(await readTokenFile(path.join(dir, "ok"))).toBe("file-token-0123456789abcdef\n");
      writeFileSync(path.join(dir, "big"), "x".repeat(TOKEN_FILE_MAX_BYTES + 1));
      await expect(readTokenFile(path.join(dir, "big"))).rejects.toThrow(/larger than 1024/);
      const r = await resolveFacilitatorToken(deps({ tokenFile: path.join(dir, "big"), readFile: readTokenFile }));
      expect(r.ok).toBe(false);
      await expect(readTokenFile(dir)).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("plainTokenWarning (review M7)", () => {
  it("warns for ws:// to a remote host with a token, never for loopback, wss:// or no token", () => {
    expect(plainTokenWarning("ws://192.168.1.20:8080", true)).toMatch(/clear text/);
    expect(plainTokenWarning("ws://example.com", true)).toMatch(/clear text/);
    for (const u of ["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://[::1]:8080", "wss://example.com"]) expect(plainTokenWarning(u, true), u).toBeNull();
    expect(plainTokenWarning("ws://192.168.1.20", false)).toBeNull();
  });
});
