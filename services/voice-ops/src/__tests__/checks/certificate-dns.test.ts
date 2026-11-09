import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caddyManagedCert, CERT_WARN_DAYS, certificateCheck } from "../../checks/certificate.js";
import { dnsCheck } from "../../checks/dns.js";
import type { CheckResult } from "../../checks/types.js";
import { privateTmp } from "../helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Task 8): the certificate check on certificates made at test time with openssl (the clock is injected
// relative to the certificate's own end date, so nothing depends on today's date), and the DNS check with faked resolvers.

const DAY = 86_400_000;
let openssl: string | null = null;
try { execFileSync("openssl", ["version"], { stdio: "ignore" }); openssl = "openssl"; } catch { openssl = null; }

let tmp: ReturnType<typeof privateTmp>;
let pem = "";
let validTo = 0;
beforeAll(() => {
  tmp = privateTmp("acr-voice-ops-cert-");
  if (!openssl) return;
  const dir = mkdtempSync(path.join(tmp.root, "c-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    "-days", "90", "-subj", "/CN=voice.pilot.example", "-addext", "subjectAltName=DNS:voice.pilot.example"], { stdio: "ignore" });
  pem = readFileSync(path.join(dir, "c.pem"), "utf8");
  validTo = new X509Certificate(pem).validToDate.getTime();
});
afterAll(() => tmp.restore());

describe("certificateCheck", () => {
  const host = "voice.pilot.example";
  it.skipIf(!openssl)("ok with days left", () => {
    const r = certificateCheck({ certPem: pem, keyMode: 0o600, hostname: host, now: validTo - 60 * DAY });
    expect(r).toEqual([
      { name: "certificate", level: "ok", line: "certificate for voice.pilot.example, 60 days left" },
      { name: "certificate-key", level: "ok", line: "the certificate's private key is readable by you only" },
    ]);
  });
  it.skipIf(!openssl)("warns at 20 days and not at 21", () => {
    expect(CERT_WARN_DAYS).toBe(21);
    expect(certificateCheck({ certPem: pem, keyMode: 0o600, hostname: host, now: validTo - 21 * DAY })[0]!.level).toBe("ok");
    const w = certificateCheck({ certPem: pem, keyMode: 0o600, hostname: host, now: validTo - 21 * DAY + 1 })[0]!;
    expect(w).toEqual({ name: "certificate", level: "warn", line: "certificate for voice.pilot.example, 20 days left: renew it soon" });
  });
  it.skipIf(!openssl)("fails expired", () => {
    expect(certificateCheck({ certPem: pem, keyMode: 0o600, hostname: host, now: validTo + 1 })[0]).toEqual({ name: "certificate", level: "fail", line: "certificate for voice.pilot.example has expired: renew it" });
  });
  it.skipIf(!openssl)("fails a hostname mismatch", () => {
    expect(certificateCheck({ certPem: pem, keyMode: 0o600, hostname: "other.pilot.example", now: validTo - 60 * DAY })[0]).toEqual({ name: "certificate", level: "fail", line: "the certificate does not name other.pilot.example" });
  });
  it("fails a key readable by the group, and a missing key", () => {
    expect(certificateCheck({ certPem: pem || null, keyMode: 0o640, hostname: host, now: validTo })[1]!.level).toBe("fail");
    expect(certificateCheck({ certPem: pem || null, keyMode: null, hostname: host, now: validTo })[1]).toEqual({ name: "certificate-key", level: "fail", line: "VOICE_TLS_KEY_FILE cannot be read" });
  });
  it("fails a missing file and a file that is not a certificate", () => {
    expect(certificateCheck({ certPem: null, keyMode: 0o600, hostname: host, now: 0 })[0]).toEqual({ name: "certificate", level: "fail", line: "VOICE_TLS_CERT_FILE cannot be read" });
    expect(certificateCheck({ certPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", keyMode: 0o600, hostname: host, now: 0 })[0]).toEqual({ name: "certificate", level: "fail", line: "VOICE_TLS_CERT_FILE is not a PEM certificate" });
  });
  it("caddyManagedCert finds Caddy's certificate for the hostname, or null", () => {
    const state = mkdtempSync(path.join(tmp.root, "s-"));
    expect(caddyManagedCert(state, host)).toBeNull();
    const d = path.join(state, "caddy-data", "caddy", "certificates", "acme-v02.api.letsencrypt.org-directory", host);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `${host}.crt`), "x");
    expect(caddyManagedCert(state, host)).toBe(path.join(d, `${host}.crt`));
    expect(caddyManagedCert(state, "../etc")).toBeNull();
  });
});

describe("dnsCheck", () => {
  const base = { hostname: "voice.pilot.example", nodeIp: "192.168.1.20", ownAddresses: ["127.0.0.1", "::1", "192.168.1.20", "fd00:1:2:3::20", "fe80::1c2b:3a4f:fe5d:6e7f"] };
  const none = async (): Promise<string[]> => { throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" }); };
  const sys = (...a: string[]) => async () => a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const at = (r: CheckResult[], n: string): CheckResult | undefined => r.find((x) => x.name === n);

  it("ok private and the node address", async () => {
    const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20"], resolve6: none, lookup: sys("192.168.1.20") });
    expect(r).toEqual([
      { name: "dns", level: "ok", line: "DNS: voice.pilot.example points to this machine (192.168.1.20)" },
      { name: "dns-system", level: "ok", line: "this machine resolves voice.pilot.example the same way" },
    ]);
  });
  it("warns another private address", async () => {
    const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.99"], resolve6: none, lookup: sys("192.168.1.99") });
    expect(at(r, "dns")!.level).toBe("warn");
    expect(at(r, "dns")!.line).toContain("not this machine's LAN address 192.168.1.20");
  });
  it("fails a public address", async () => {
    const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20", "203.0.113.7"], resolve6: none, lookup: sys("192.168.1.20") });
    expect(at(r, "dns")).toEqual({ name: "dns", level: "fail", line: "DNS: voice.pilot.example points to a public address (203.0.113.7): point it to this machine's LAN address 192.168.1.20" });
  });
  it("no answer fails with the DNS-rebinding hint", async () => {
    const r = await dnsCheck({ ...base, resolve4: none, resolve6: none, lookup: sys("192.168.1.20") });
    expect(at(r, "dns")!.level).toBe("fail");
    expect(at(r, "dns")!.line).toContain("some routers drop public DNS answers that point to a private address (DNS-rebinding protection): allow the hostname in the router, or add a local DNS entry");
  });
  it("uses resolve4 and resolve6, not lookup, for the DNS line", async () => {
    const asked: string[] = [];
    const r = await dnsCheck({ ...base, resolve4: async (h) => { asked.push(`4:${h}`); return []; }, resolve6: async (h) => { asked.push(`6:${h}`); return []; }, lookup: async (h) => { asked.push(`lookup:${h}`); return [{ address: "192.168.1.20", family: 4 }]; } });
    expect(asked.sort()).toEqual(["4:voice.pilot.example", "6:voice.pilot.example", "lookup:voice.pilot.example"]);
    // the hosts file answers, DNS does not: the DNS line still fails
    expect(at(r, "dns")!.level).toBe("fail");
    expect(at(r, "dns-system")!.level).toBe("warn");
  });
  it("a hosts-file answer different from DNS warns", async () => {
    const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20"], resolve6: none, lookup: sys("127.0.0.1") });
    expect(at(r, "dns-system")).toEqual({ name: "dns-system", level: "warn", line: "this machine resolves voice.pilot.example through its hosts file or another resolver; other devices use DNS" });
  });
  // Review B2 F8: an AAAA that is not one of this machine's own addresses sends a browser elsewhere (with a certificate for this name it
  // fails TLS there, with no fallback to the A record): FAIL, a unique-local one included. This machine's own IPv6 address only warns:
  // Caddy binds IPv4 only and Happy Eyeballs falls back to the A record.
  it("an AAAA that is not this machine's fails, a unique-local one included", async () => {
    for (const aaaa of ["2001:db8::5", "fd12:3456::5"]) {
      const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20"], resolve6: async () => [aaaa], lookup: sys("192.168.1.20", aaaa) });
      expect(at(r, "dns-ipv6"), aaaa).toEqual({ name: "dns-ipv6", level: "fail", line: `DNS: voice.pilot.example has an IPv6 (AAAA) address that is not this machine (${aaaa}): browsers may use it and fail; remove the AAAA record` });
      expect(at(r, "dns")!.level).toBe("ok");
    }
  });
  it("an AAAA of this machine's own (any spelling) only warns", async () => {
    for (const aaaa of ["fd00:1:2:3::20", "FD00:0001:0002:0003:0000:0000:0000:0020"]) {
      const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20"], resolve6: async () => [aaaa], lookup: sys("192.168.1.20", aaaa) });
      expect(at(r, "dns-ipv6"), aaaa).toEqual({ name: "dns-ipv6", level: "warn", line: "DNS: voice.pilot.example also has an IPv6 (AAAA) address of this machine: the proxy listens on IPv4 only; browsers fall back to IPv4, but remove the AAAA record if connecting is slow" });
    }
  });
  it("a loopback or link-local A answer is not called a public address", async () => {
    for (const a of ["127.0.0.1", "169.254.10.20"]) {
      const r = await dnsCheck({ ...base, resolve4: async () => [a], resolve6: none, lookup: sys(a) });
      expect(at(r, "dns"), a).toEqual({ name: "dns", level: "fail", line: `DNS: voice.pilot.example points to a loopback or link-local address (${a}): point it to this machine's LAN address 192.168.1.20` });
    }
  });
  it("a system resolver that fails warns", async () => {
    const r = await dnsCheck({ ...base, resolve4: async () => ["192.168.1.20"], resolve6: none, lookup: async () => { throw new Error("ENOTFOUND"); } });
    expect(at(r, "dns-system")).toEqual({ name: "dns-system", level: "warn", line: "this machine cannot resolve voice.pilot.example" });
  });
});
