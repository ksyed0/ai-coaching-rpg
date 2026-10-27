import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config";

const key = (): string => randomBytes(32).toString("base64");
const base = (): Record<string, string> => ({ RUNTIME_URL: "wss://runtime.internal:8443", PUBLIC_ORIGIN: "https://play.example.org", COOKIE_KEYS: `k1:${key()}` });

describe("loadConfig", () => {
  it("parses a valid environment and applies defaults", () => {
    const c = loadConfig({ ...base(), COOKIE_KEYS: `new:${key()},old-1:${key()}` });
    expect(c.runtimeUrl).toBe("wss://runtime.internal:8443");
    expect(c.publicOrigin).toBe("https://play.example.org");
    expect(c.cookieKeys.map((k) => k.id)).toEqual(["new", "old-1"]);
    expect(c.cookieKeys.every((k) => k.key.length === 32)).toBe(true);
    expect([c.cookieMaxAgeHours, c.maxStreams, c.maxStreamsPerSession, c.maxStreamsPerAddress]).toEqual([12, 200, 64, 16]);
  });

  it("reads explicit numeric settings", () => {
    const c = loadConfig({ ...base(), COOKIE_MAX_AGE_HOURS: "24", WEB_MAX_STREAMS: "10", WEB_MAX_STREAMS_PER_SESSION: "5", WEB_MAX_STREAMS_PER_ADDRESS: "2" });
    expect([c.cookieMaxAgeHours, c.maxStreams, c.maxStreamsPerSession, c.maxStreamsPerAddress]).toEqual([24, 10, 5, 2]);
  });

  it("loadConfig refuses a short key and a missing PUBLIC_ORIGIN without quoting them", () => {
    const shortKey = Buffer.alloc(16, 7).toString("base64");
    let message = "";
    try { loadConfig({ RUNTIME_URL: "wss://secret-host.example:9", COOKIE_KEYS: `k1:${shortKey}` }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("COOKIE_KEYS");
    expect(message).toContain("PUBLIC_ORIGIN");
    expect(message).not.toContain(shortKey);
    expect(message).not.toContain("secret-host");
  });

  it("collects every problem into one message", () => {
    expect(() => loadConfig({})).toThrow(/RUNTIME_URL[\s\S]*PUBLIC_ORIGIN[\s\S]*COOKIE_KEYS/);
  });

  it.each([
    ["RUNTIME_URL", "http://runtime"], ["RUNTIME_URL", "not a url"], ["RUNTIME_URL", "ws://user:pw@h"],
    ["PUBLIC_ORIGIN", "https://play.example.org/path"], ["PUBLIC_ORIGIN", "play.example.org"], ["PUBLIC_ORIGIN", "https://play.example.org/"], ["PUBLIC_ORIGIN", "ftp://x"],
    ["COOKIE_MAX_AGE_HOURS", "000"], ["COOKIE_MAX_AGE_HOURS", "169"], ["COOKIE_MAX_AGE_HOURS", "7.5"], ["COOKIE_MAX_AGE_HOURS", "abc"],
    ["WEB_MAX_STREAMS", "-3"], ["WEB_MAX_STREAMS", "99999"], ["WEB_MAX_STREAMS", "10001"], ["WEB_MAX_STREAMS_PER_SESSION", "1001"], ["WEB_MAX_STREAMS_PER_ADDRESS", "-9"],
  ])("rejects %s=%s by name without echoing the value", (name, value) => {
    let message = "";
    try { loadConfig({ ...base(), [name]: value }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(name);
    expect(message).not.toContain(value);
  });

  it("accepts a ws:// runtime and an origin with a port", () => {
    const c = loadConfig({ ...base(), RUNTIME_URL: "ws://localhost:8787", PUBLIC_ORIGIN: "http://localhost:3000" });
    expect(c.publicOrigin).toBe("http://localhost:3000");
  });

  it.each([
    ["bad id chars", `a b:${key()}`], ["empty id", `:${key()}`], ["id too long", `${"a".repeat(17)}:${key()}`],
    ["no colon", key()], ["bad base64", "k1:!!!!"], ["33 bytes", `k1:${randomBytes(33).toString("base64")}`],
    ["empty list", ""], ["duplicate ids", `k1:${key()},k1:${key()}`],
    ["nine keys", Array.from({ length: 9 }, (_, i) => `k${i}:${key()}`).join(",")],
  ])("rejects COOKIE_KEYS: %s", (_label, value) => {
    expect(() => loadConfig({ ...base(), COOKIE_KEYS: value })).toThrow(/COOKIE_KEYS/);
  });

  it("accepts eight keys", () => {
    const c = loadConfig({ ...base(), COOKIE_KEYS: Array.from({ length: 8 }, (_, i) => `k${i}:${key()}`).join(",") });
    expect(c.cookieKeys).toHaveLength(8);
  });
});
