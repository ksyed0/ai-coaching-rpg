import { createHmac } from "node:crypto";
import type { Config } from "./config";
import { unseal } from "./seal";

// The facilitator's cookie. It is sealed for the "fac" purpose (a player cookie never opens as one, nor the reverse) and carries an
// epoch derived from FACILITATOR_SECRET, so changing the secret signs every facilitator out. Nothing secret is in it.

export const CONSOLE_COOKIE = "__Host-scenecoach-fac";
export const MAX_CONSOLE_NAME_CODE_POINTS = 60;

export type ConsoleSession = { name: string; epoch: string; expiresAt: number };

/** First 16 hex of HMAC-SHA256(secret, "scenecoach-fac-epoch"): changes whenever the secret does, reveals nothing about it. */
export function secretEpoch(secret: string): string {
  return createHmac("sha256", secret)
    .update("scenecoach-fac-epoch")
    .digest("hex")
    .slice(0, 16);
}

// Controls, soft hyphen, zero-width and bidirectional characters, line and paragraph separators, word joiners and invisible
// operators, BOM, variation selectors 1-14 and tag characters: the runtime's hidden-character table, in the subset a name can carry.
// Numeric inclusive ranges, so no invisible character is ever written into this file.
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0d],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe00ff],
  [0xe01f0, 0xe0fff],
];
const isHidden = (cp: number): boolean =>
  HIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** The facilitator's name as shown to players: hidden characters removed, trimmed, cut at 60 code points. Null when nothing is left. */
export function cleanConsoleName(raw: string): string | null {
  const name = [
    ...[...raw]
      .filter((ch) => !isHidden(ch.codePointAt(0)!))
      .join("")
      .trim(),
  ]
    .slice(0, MAX_CONSOLE_NAME_CODE_POINTS)
    .join("")
    .trim();
  return name.length > 0 ? name : null;
}

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
