import { describe, expect, it } from "vitest";
import { checkFetchSite, checkOrigin, clientAddress, normalizeAddress, requestAddress } from "../guards";

const ORIGIN = "https://play.example.org";
const req = (headers: Record<string, string>) => new Request("https://play.example.org/api/v1/x", { method: "POST", headers });

describe("checkOrigin", () => {
  it("is true with the exact origin and the custom header", () => {
    expect(checkOrigin(req({ Origin: ORIGIN, "X-Requested-With": "scenecoach" }), ORIGIN)).toBe(true);
  });
  it("checkOrigin is false without the custom header", () => {
    expect(checkOrigin(req({ Origin: ORIGIN }), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest" }), ORIGIN)).toBe(false);
  });
  it("is false for a missing, different, suffixed or null origin", () => {
    const h = { "X-Requested-With": "scenecoach" };
    expect(checkOrigin(req(h), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ ...h, Origin: "https://evil.example" }), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ ...h, Origin: ORIGIN + ".evil.example" }), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ ...h, Origin: ORIGIN + "/" }), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ ...h, Origin: "null" }), ORIGIN)).toBe(false);
    expect(checkOrigin(req({ ...h, Origin: "http://play.example.org" }), ORIGIN)).toBe(false);
  });
});

describe("checkFetchSite", () => {
  it("allows same-origin, none and absent", () => {
    expect(checkFetchSite(req({ "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(checkFetchSite(req({ "Sec-Fetch-Site": "none" }))).toBe(true);
    expect(checkFetchSite(req({}))).toBe(true);
  });
  it("refuses cross-site, same-site and unknown values", () => {
    expect(checkFetchSite(req({ "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(checkFetchSite(req({ "Sec-Fetch-Site": "same-site" }))).toBe(false);
    expect(checkFetchSite(req({ "Sec-Fetch-Site": "weird" }))).toBe(false);
  });
});

describe("clientAddress", () => {
  it("clientAddress takes the last entry", () => {
    expect(clientAddress(req({ "X-Forwarded-For": "6.6.6.6, 10.0.0.1 ,  203.0.113.9 " }))).toBe("203.0.113.9");
    expect(clientAddress(req({ "X-Forwarded-For": "203.0.113.9" }))).toBe("203.0.113.9");
  });
  it("is unknown when absent, empty or oversize", () => {
    expect(clientAddress(req({}))).toBe("unknown");
    expect(clientAddress(req({ "X-Forwarded-For": "1.1.1.1, " }))).toBe("unknown");
    expect(clientAddress(req({ "X-Forwarded-For": " " }))).toBe("unknown");
    expect(clientAddress(req({ "X-Forwarded-For": "a".repeat(65) }))).toBe("unknown");
    expect(clientAddress(req({ "X-Forwarded-For": "a".repeat(64) }))).toBe("a".repeat(64));
  });
});

describe("normalizeAddress", () => {
  it("keeps a plain IPv4 address and folds every IPv4-mapped IPv6 spelling onto it", () => {
    for (const a of ["198.51.100.7", "::ffff:198.51.100.7", "::FFFF:198.51.100.7", "[::ffff:198.51.100.7]", "::ffff:c633:6407", "0:0:0:0:0:ffff:c633:6407", " 198.51.100.7 "]) {
      expect(normalizeAddress(a), a).toBe("198.51.100.7");
    }
  });
  it("gives one canonical spelling for an IPv6 address", () => {
    for (const a of ["2001:db8::1", "2001:DB8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "[2001:db8::1]"]) expect(normalizeAddress(a), a).toBe("2001:db8::1");
    expect(normalizeAddress("::1")).toBe("::1");
  });
  it("is null for anything that is not one IP address", () => {
    for (const a of ["", " ", "unknown", "example.org", "198.51.100.7:443", "1.2.3", "fe80::1%eth0", "1.2.3.4, 5.6.7.8", "[::1", "::ffff:zzzz:1"]) expect(normalizeAddress(a), a).toBeNull();
  });
});

describe("requestAddress", () => {
  it("normalises the one X-Forwarded-For entry the trusted proxy set", () => {
    expect(requestAddress(req({ "X-Forwarded-For": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
    expect(requestAddress(req({ "X-Forwarded-For": "2001:DB8::0001" }))).toBe("2001:db8::1");
  });
  it("is untrusted (null) for an empty, comma-separated or non-address header", () => {
    for (const v of ["", " ", "6.6.6.6, 203.0.113.9", "203.0.113.9,", ",", "unknown"]) expect(requestAddress(req({ "X-Forwarded-For": v })), JSON.stringify(v)).toBeNull();
  });
  it("is the shared key unknown when no proxy header is present (a deployment requirement: the proxy always sets it)", () => {
    expect(requestAddress(req({}))).toBe("unknown");
  });
});
