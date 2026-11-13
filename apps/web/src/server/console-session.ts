import { createHmac } from "node:crypto";
import type { Config } from "./config";
import { cleanConsoleName, MAX_CONSOLE_NAME_CODE_POINTS } from "@acr/events";
import { unseal } from "./seal";

// The facilitator's cookie. It is sealed for the "fac" purpose (a player cookie never opens as one, nor the reverse). Nothing secret is in it.
// US-0083: two shapes. An ACCOUNT cookie carries `kind: "account"`, the account id and the account's epoch at sign-in; every request
// re-checks that pair with the control service (console-handlers.ts requireConsole), so a revoke, reset or password change (each bumps
// the epoch) ends it at once. A cookie WITHOUT `kind` is LEGACY (the shared FACILITATOR_SECRET sign-in): it carries an epoch derived
// from the secret, and works only while control's legacy latch is open. Cookies live at deploy have no `kind`, so they keep working
// until the latch closes.

export const CONSOLE_COOKIE = "__Host-scenecoach-fac";

export type AccountCookie = { kind: "account"; accountId: string; epoch: number; name: string; expiresAt: number };
export type LegacyCookie = { name: string; epoch: string; expiresAt: number };
export type ConsoleCookie = AccountCookie | LegacyCookie;

/** First 16 hex of HMAC-SHA256(secret, "scenecoach-fac-epoch"): changes whenever the secret does, reveals nothing about it. */
export function secretEpoch(secret: string): string {
  return createHmac("sha256", secret)
    .update("scenecoach-fac-epoch")
    .digest("hex")
    .slice(0, 16);
}

// cleanConsoleName and its hidden-character table live in @acr/events so the control service cleans account names the same way.
export { cleanConsoleName, MAX_CONSOLE_NAME_CODE_POINTS };

/** Matches the control service's account id rule (1 to 64 characters). */
const MAX_ACCOUNT_ID_CHARS = 64;

function isAccountCookie(c: Record<string, unknown>): boolean {
  return (
    c.kind === "account" &&
    typeof c.accountId === "string" &&
    c.accountId.length >= 1 &&
    c.accountId.length <= MAX_ACCOUNT_ID_CHARS &&
    typeof c.epoch === "number" &&
    Number.isSafeInteger(c.epoch) &&
    c.epoch >= 0 &&
    typeof c.name === "string" &&
    typeof c.expiresAt === "number"
  );
}

function isLegacyCookie(c: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(c, "kind") &&
    typeof c.name === "string" &&
    typeof c.epoch === "string" &&
    typeof c.expiresAt === "number"
  );
}

/**
 * What this cookie value holds, or null: it does not open, has expired, has an unknown shape or `kind`, or is a legacy cookie whose
 * epoch is not the current secret's (or no secret is set). Opening is local only: an account cookie must still be re-checked.
 */
export function openConsoleCookie(
  token: string | undefined,
  config: Config,
  now: number,
): ConsoleCookie | null {
  if (!token) return null;
  const v = unseal<unknown>(token, config.cookieKeys, now, "fac");
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (isAccountCookie(c)) {
    return { kind: "account", accountId: c.accountId as string, epoch: c.epoch as number, name: c.name as string, expiresAt: c.expiresAt as number };
  }
  if (isLegacyCookie(c)) {
    if (!config.facilitatorSecret || c.epoch !== secretEpoch(config.facilitatorSecret)) return null;
    return { name: c.name as string, epoch: c.epoch as string, expiresAt: c.expiresAt as number };
  }
  return null;
}

export const isAccountCookieValue = (c: ConsoleCookie): c is AccountCookie => "kind" in c && c.kind === "account";

export function readConsoleCookie(req: Request): string | undefined {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${CONSOLE_COOKIE}=`))
      return p.slice(CONSOLE_COOKIE.length + 1);
  }
  return undefined;
}
