import { describe, expect, it } from "vitest";
import { checkFetchSite, checkOrigin, clientAddress } from "../guards";

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
