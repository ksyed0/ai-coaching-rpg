import { describe, expect, it } from "vitest";
import { AuthThrottle, DEFAULT_LIMITS, TokenBucket, WindowCounter, clientIp, isValidToken, normalizeOrigin, parseSecurityConfig, secretsMatch } from "../security.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("secretsMatch", () => {
  it("matches equal strings and refuses different, empty and different-length ones", () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true);
    expect(secretsMatch(TOKEN, TOKEN.slice(0, -1) + "x")).toBe(false);
    expect(secretsMatch(TOKEN, "")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
    expect(secretsMatch(TOKEN, TOKEN + "0")).toBe(false);
    expect(secretsMatch(TOKEN, "x".repeat(100_000))).toBe(false);
  });
});

describe("isValidToken", () => {
  it("accepts 16 to 256 printable characters without whitespace", () => {
    expect(isValidToken("a".repeat(16))).toBe(true);
    expect(isValidToken("a".repeat(256))).toBe(true);
    expect(isValidToken("a".repeat(15))).toBe(false);
    expect(isValidToken("a".repeat(257))).toBe(false);
    expect(isValidToken("has space in it 123456")).toBe(false);
    expect(isValidToken("tab\there0123456789abc")).toBe(false);
    expect(isValidToken("unicode-é-0123456789abcdef")).toBe(false);
  });
});

describe("parseSecurityConfig", () => {
  it("defaults: no token, open, documented limits", () => {
    const r = parseSecurityConfig({});
    expect(r).toEqual({ ok: true, config: { facilitatorToken: undefined, host: "0.0.0.0", allowedOrigins: [], trustProxy: false, limits: DEFAULT_LIMITS } });
  });
  it("reads every variable", () => {
    const r = parseSecurityConfig({ FACILITATOR_TOKEN: TOKEN, RUNTIME_HOST: "127.0.0.1", ALLOWED_ORIGINS: "https://a.example, http://localhost:3000", TRUST_PROXY: "1", WS_MAX_CONNECTIONS: "10", WS_MAX_CONNECTIONS_PER_IP: "2", WS_MSG_RATE: "9", WS_MSG_BURST: "30", WS_JOIN_TIMEOUT_MS: "1500" });
    expect(r.ok && r.config).toMatchObject({ facilitatorToken: TOKEN, host: "127.0.0.1", allowedOrigins: ["https://a.example", "http://localhost:3000"], trustProxy: true });
    expect(r.ok && r.config.limits).toMatchObject({ maxConnections: 10, maxConnectionsPerIp: 2, msgRate: 9, msgBurst: 30, joinTimeoutMs: 1500 });
  });
  it("treats a blank token as unset", () => {
    const r = parseSecurityConfig({ FACILITATOR_TOKEN: "" });
    expect(r.ok && r.config.facilitatorToken).toBeUndefined();
  });
  it("never echoes an invalid token, in any error", () => {
    for (const bad of ["short", "has spaces in the token value", "x".repeat(300), "secret\u0000value-0123456789"]) {
      const r = parseSecurityConfig({ FACILITATOR_TOKEN: bad });
      expect(r.ok).toBe(false);
      const text = JSON.stringify(r);
      expect(text).toContain("FACILITATOR_TOKEN");
      expect(text).not.toContain(bad.slice(0, 8) === "x".repeat(8) ? "xxxxxxxx" : bad.slice(0, 5));
    }
  });
  it("names the variable and the range for each bad value", () => {
    const cases: [string, string][] = [
      ["WS_MAX_CONNECTIONS", "0"], ["WS_MAX_CONNECTIONS", "10001"], ["WS_MAX_CONNECTIONS_PER_IP", "-1"], ["WS_MSG_RATE", "1.5"], ["WS_MSG_BURST", "abc"],
      ["WS_JOIN_TIMEOUT_MS", "100"], ["WS_JOIN_TIMEOUT_MS", "10s"], ["TRUST_PROXY", "yes"], ["RUNTIME_HOST", "bad host!"], ["ALLOWED_ORIGINS", "not a url"], ["ALLOWED_ORIGINS", "https://a.example/path"],
    ];
    for (const [name, value] of cases) {
      const r = parseSecurityConfig({ [name]: value });
      expect(r.ok, `${name}=${value}`).toBe(false);
      expect(!r.ok && r.errors.join(" ")).toContain(name);
    }
  });
  it("collects several errors at once", () => {
    const r = parseSecurityConfig({ WS_MSG_RATE: "0", WS_MSG_BURST: "0" });
    expect(!r.ok && r.errors.length).toBe(2);
  });
});

describe("normalizeOrigin", () => {
  it("accepts scheme://host[:port] only", () => {
    expect(normalizeOrigin("https://Play.Example.com")).toBe("https://play.example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["null", "ftp://x.example", "https://x.example/", "https://x.example/p", "https://u:p@x.example", "x.example"]) expect(normalizeOrigin(bad), bad).toBeNull();
  });
});

describe("TokenBucket", () => {
  it("allows the burst, then refills at the rate, never above the burst", () => {
    let t = 0;
    const b = new TokenBucket(5, 3, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t += 199; expect(b.take()).toBe(false);
    t += 1; expect(b.take()).toBe(true); // 200 ms at 5/s = 1 token
    t += 60_000; expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
  it("two buckets are independent", () => {
    const t = 0;
    const a = new TokenBucket(1, 1, () => t); const b = new TokenBucket(1, 1, () => t);
    expect(a.take()).toBe(true); expect(a.take()).toBe(false); expect(b.take()).toBe(true);
  });
});

describe("WindowCounter and AuthThrottle", () => {
  it("counts only events inside the window", () => {
    let t = 0;
    const c = new WindowCounter(1000, () => t);
    expect(c.hit()).toBe(1); t += 500; expect(c.hit()).toBe(2); t += 600; expect(c.hit()).toBe(2);
  });
  it("blocks an IP after more than max failures, for blockMs, and only that IP", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => t });
    for (let i = 0; i < 5; i++) th.fail("1.1.1.1");
    expect(th.blockedForMs("1.1.1.1")).toBe(0);
    th.fail("1.1.1.1");
    expect(th.blockedForMs("1.1.1.1")).toBe(60_000);
    expect(th.blockedForMs("2.2.2.2")).toBe(0);
    t += 59_999; expect(th.blockedForMs("1.1.1.1")).toBe(1);
    t += 1; expect(th.blockedForMs("1.1.1.1")).toBe(0);
    th.fail("1.1.1.1"); expect(th.blockedForMs("1.1.1.1")).toBe(0); // the counter restarted
  });
  it("failures spread over more than a window never block", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 2, windowMs: 1000, blockMs: 5000, now: () => t });
    for (let i = 0; i < 10; i++) { th.fail("x"); t += 600; }
    expect(th.blockedForMs("x")).toBe(0);
  });
});

describe("clientIp", () => {
  const req = (xff?: string) => ({ socket: { remoteAddress: "10.0.0.9" }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  it("uses the socket unless the proxy is trusted", () => {
    expect(clientIp(req("1.2.3.4"), false)).toBe("10.0.0.9");
    expect(clientIp(req("9.9.9.9, 1.2.3.4"), true)).toBe("1.2.3.4");
    expect(clientIp(req(), true)).toBe("10.0.0.9");
    expect(clientIp(req("x".repeat(200)), true)).toBe("10.0.0.9");
  });
});
