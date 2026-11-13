import { createHmac } from "node:crypto";
import type { Config } from "./config";
import { cleanConsoleName, MAX_CONSOLE_NAME_CODE_POINTS } from "@acr/events";
import { unseal } from "./seal";

// The facilitator's cookie. It is sealed for the "fac" purpose (a player cookie never opens as one, nor the reverse) and carries an
// epoch derived from FACILITATOR_SECRET, so changing the secret signs every facilitator out. Nothing secret is in it.

export const CONSOLE_COOKIE = "__Host-scenecoach-fac";

export type ConsoleSession = { name: string; epoch: string; expiresAt: number };

/** First 16 hex of HMAC-SHA256(secret, "scenecoach-fac-epoch"): changes whenever the secret does, reveals nothing about it. */
export function secretEpoch(secret: string): string {
  return createHmac("sha256", secret)
    .update("scenecoach-fac-epoch")
    .digest("hex")
    .slice(0, 16);
}

// cleanConsoleName and its hidden-character table live in @acr/events so the control service cleans account names the same way.
export { cleanConsoleName, MAX_CONSOLE_NAME_CODE_POINTS };

function isConsoleSession(v: unknown): v is ConsoleSession {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    typeof c.epoch === "string" &&
    typeof c.expiresAt === "number"
  );
}

/** For server pages, which have cookies but no Request: the live session this cookie value holds, or null. */
export function consoleSessionFromToken(
  token: string | undefined,
  config: Config,
  now: number,
): ConsoleSession | null {
  if (!token || !config.facilitatorSecret) return null;
  const c = unseal<unknown>(token, config.cookieKeys, now, "fac");
  if (!isConsoleSession(c) || c.epoch !== secretEpoch(config.facilitatorSecret))
    return null;
  return c;
}

export function readConsoleCookie(req: Request): string | undefined {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${CONSOLE_COOKIE}=`))
      return p.slice(CONSOLE_COOKIE.length + 1);
  }
  return undefined;
}

export function readConsoleSession(
  req: Request,
  config: Config,
  now: number,
): ConsoleSession | null {
  return consoleSessionFromToken(readConsoleCookie(req), config, now);
}
