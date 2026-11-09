import { describe, expect, it } from "vitest";
import { isHex, isHostname, isPrivateAddress, isSafeIdText, parseIPv4 } from "../text.js";

// US-0072 (EPIC-0003 voice A1c, Task 1): character-level validators (no letters-digits-underscore class outside packages/events, R13).
describe("isHex (US-0072)", () => {
  it("accepts exactly length lowercase hex", () => {
    expect(isHex("0123456789abcdef", 16)).toBe(true);
    expect(isHex("", 0)).toBe(true);
  });
  it("refuses upper case, g, other characters and a length off by one", () => {
    expect(isHex("0123456789ABCDEF", 16)).toBe(false);
    expect(isHex("0123456789abcdeg", 16)).toBe(false);
    expect(isHex("0123456789abcde", 16)).toBe(false);
    expect(isHex("0123456789abcdef0", 16)).toBe(false);
    expect(isHex("0123456789abcde ", 16)).toBe(false);
    expect(isHex("/", 1)).toBe(false);
    expect(isHex(":", 1)).toBe(false);
    expect(isHex("`", 1)).toBe(false);
  });
});

describe("isHostname (US-0072)", () => {
  it.each(["pilot.example.com", "a.b", "Pilot-1.Example.COM", "x1.example", `${"a".repeat(63)}.example`, "a.b2c"])("accepts %s", (h) => {
    expect(isHostname(h)).toBe(true);
  });
  it.each(["localhost", "pilot.localhost", "LOCALHOST", "pilot", "-a.example", "a-.example", "a..b", ".a.b", "a.b.", "1.2.3.4", "a.123",
    `${"a".repeat(64)}.example`, "a_b.example", "a b.example", "é.example", "", "a.b:443", "a/b.example", `${"a.".repeat(126)}ab`])("refuses %j", (h) => {
    expect(isHostname(h)).toBe(false);
  });
  it("refuses more than 253 characters and accepts 253", () => {
    const label = "a".repeat(61);
    const ok = [label, label, label, label].join(".") + ".ab"; // 4 * 61 + 4 dots + 2 = 250
    expect(ok.length).toBe(250);
    expect(isHostname(ok)).toBe(true);
    expect(isHostname(ok + "cde")).toBe(true); // 253
    expect(isHostname(ok + "cdef")).toBe(false); // 254
  });
});

describe("parseIPv4 (US-0072)", () => {
  it("parses dotted quads", () => {
    expect(parseIPv4("192.168.1.20")).toEqual([192, 168, 1, 20]);
    expect(parseIPv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseIPv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });
  it.each(["1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.04", "1.2.3.", "a.b.c.d", "1.2.3.-4", "1.2.3.4 ", "", "1..2.3", "1234.1.1.1", "+1.2.3.4"])("refuses %j", (v) => {
    expect(parseIPv4(v)).toBeNull();
  });
});

describe("isPrivateAddress (US-0072)", () => {
  it.each(["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.20", "fd12::1", "fc00::", "FD00:1:2::3"])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["172.32.0.1", "172.15.255.255", "8.8.8.8", "127.0.0.1", "169.254.1.1", "192.169.0.1", "11.0.0.1", "::1", "fe80::1", "::", "2001:db8::1",
    "1.2.3", "256.1.1.1", "01.2.3.4", "fd12:::1", "fd12::g", "", "pilot.example"])("%j is not private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("isSafeIdText (US-0072)", () => {
  it("accepts 1 to 64 letters, digits, _ and -", () => {
    expect(isSafeIdText("a")).toBe(true);
    expect(isSafeIdText("Az09_-")).toBe(true);
    expect(isSafeIdText("x".repeat(64))).toBe(true);
  });
  it.each(["", "x".repeat(65), "a.b", "a b", "é", "a/b", "@", "[", "`", "{"])("refuses %j", (v) => {
    expect(isSafeIdText(v)).toBe(false);
  });
});
