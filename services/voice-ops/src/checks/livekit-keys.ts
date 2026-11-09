import { createHmac } from "node:crypto";
import { loopbackRequest } from "./loopback.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): proves that control's keys (the merged view) are LiveKit's. A SERVER API token, never a
 * participant token: HS256 over `{ iss: <key>, nbf: now, exp: now + 60 s, video: { roomList: true } }` with `node:crypto` (no new
 * dependency), sent once as a bearer token to `POST <host>/twirp/livekit.RoomService/ListRooms` on loopback (node:http, `agent: false`:
 * never through an environment proxy). The room list is read for its status only and dropped; the token, the key and the secret are
 * never printed.
 */
export const ADMIN_TOKEN_TTL_S = 60;

export function adminToken(key: string, secret: string, now: number): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  const nbf = Math.floor(now / 1000);
  const head = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ iss: key, nbf, exp: nbf + ADMIN_TOKEN_TTL_S, video: { roomList: true } })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

export async function livekitKeysCheck(o: { host: URL; key: string | undefined; secret: string | undefined; now: number }): Promise<CheckResult> {
  const r = (level: CheckResult["level"], line: string): CheckResult => ({ name: "livekit-keys", level, line });
  if (o.key === undefined || o.key === "" || o.secret === undefined || o.secret === "") return r("skip", "LiveKit keys are not set in .env: run pnpm voice:up");
  const url = new URL("/twirp/livekit.RoomService/ListRooms", o.host);
  const a = await loopbackRequest(url, {
    method: "POST", body: "{}", limit: 1024,
    headers: { authorization: `Bearer ${adminToken(o.key, o.secret, o.now)}`, "content-type": "application/json", "content-length": "2" },
  });
  if (a === null) return r("skip", "LiveKit did not answer the key check (see the LiveKit line)");
  if (a.status === 200) return r("ok", "LiveKit accepts control's keys");
  if (a.status === 401) return r("fail", "LiveKit does not accept control's keys: run pnpm voice:down and pnpm voice:up");
  return r("warn", `LiveKit answered the key check with HTTP ${a.status}`);
}
