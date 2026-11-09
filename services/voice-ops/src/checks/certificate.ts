import { X509Certificate } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isHostname } from "../text.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): the owner's certificate (`VOICE_TLS_CERT_FILE`) and its key's permissions. `now` is injected.
 * Days left are whole days, rounded down; fewer than CERT_WARN_DAYS is a warning.
 */
export const CERT_WARN_DAYS = 21;
const DAY_MS = 86_400_000;

export function certificateCheck(o: { certPem: string | null; keyMode: number | null; hostname: string; now: number }): CheckResult[] {
  const cert = ((): CheckResult => {
    const r = (level: CheckResult["level"], line: string): CheckResult => ({ name: "certificate", level, line });
    if (o.certPem === null) return r("fail", "VOICE_TLS_CERT_FILE cannot be read");
    let c: X509Certificate;
    try { c = new X509Certificate(o.certPem); } catch { return r("fail", "VOICE_TLS_CERT_FILE is not a PEM certificate"); }
    if (c.checkHost(o.hostname) === undefined) return r("fail", `the certificate does not name ${o.hostname}`);
    const from = c.validFromDate.getTime();
    const to = c.validToDate.getTime();
    if (o.now < from) return r("fail", `the certificate for ${o.hostname} is not valid yet`);
    if (o.now > to) return r("fail", `certificate for ${o.hostname} has expired: renew it`);
    const days = Math.floor((to - o.now) / DAY_MS);
    if (days < CERT_WARN_DAYS) return r("warn", `certificate for ${o.hostname}, ${days} days left: renew it soon`);
    return r("ok", `certificate for ${o.hostname}, ${days} days left`);
  })();
  const key: CheckResult = o.keyMode === null ? { name: "certificate-key", level: "fail", line: "VOICE_TLS_KEY_FILE cannot be read" }
    : (o.keyMode & 0o077) !== 0 ? { name: "certificate-key", level: "fail", line: "VOICE_TLS_KEY_FILE is readable by other users: run chmod 600 on it" }
      : { name: "certificate-key", level: "ok", line: "the certificate's private key is readable by you only" };
  return [cert, key];
}

/** Caddy's own certificate for the hostname (Task 13's dns mode): `<stateDir>/caddy-data/caddy/certificates/<issuer>/<host>/<host>.crt`. */
export function caddyManagedCert(stateDir: string, hostname: string): string | null {
  if (!isHostname(hostname)) return null;
  const base = path.join(stateDir, "caddy-data", "caddy", "certificates");
  let issuers: string[];
  try { issuers = readdirSync(base); } catch { return null; }
  for (const issuer of issuers.sort()) {
    const f = path.join(base, issuer, hostname, `${hostname}.crt`);
    try { if (statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
