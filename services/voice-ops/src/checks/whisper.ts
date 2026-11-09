import { whisperHealth, type HealthAnswer } from "../whisper.js";
import { loopbackRequest } from "./loopback.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): a running whisper-server, observed read-only: `GET <STT_URL>/health` (whisper.ts
 * `whisperHealth`), then `OPTIONS <STT_URL>/inference` with `Origin: https://voice-check.invalid` to record whether it answers
 * cross-origin requests (C9's recorded check; R7: the header's value was never observed). Reports `*` or "a specific origin", never a
 * header value, and never the URL (its path is a secret).
 */
export const CHECK_ORIGIN = "https://voice-check.invalid";

export async function whisperCheck(o: {
  sttUrl: URL; health?: (u: URL) => Promise<HealthAnswer>; corsOrigin?: (u: URL) => Promise<string | null | undefined>;
}): Promise<CheckResult[]> {
  const h = await (o.health ?? ((u: URL) => whisperHealth(u)))(o.sttUrl);
  if (h === "down") return [{ name: "whisper", level: "fail", line: "whisper-server does not answer on 127.0.0.1: run pnpm voice:up" }];
  const out: CheckResult[] = [h === "ok"
    ? { name: "whisper", level: "ok", line: "whisper-server is healthy on 127.0.0.1" }
    : { name: "whisper", level: "warn", line: "whisper-server is loading its model: check again in a minute" }];
  const acao = await (o.corsOrigin ?? corsOriginOf)(o.sttUrl);
  if (acao === undefined) out.push({ name: "whisper-cors", level: "skip", line: "whisper-server did not answer the cross-origin probe" });
  else if (acao === null) out.push({ name: "whisper-cors", level: "ok", line: "whisper-server does not answer cross-origin requests" });
  else out.push({ name: "whisper-cors", level: "warn", line: `whisper-server answers cross-origin requests for ${acao.trim() === "*" ? "any origin (*)" : "a specific origin"}: keep the STT_URL path secret (docs/VOICE_RUNBOOK.md)` });
  return out;
}

/** The Access-Control-Allow-Origin of the preflight answer: null when absent, undefined when there was no answer. */
async function corsOriginOf(sttUrl: URL): Promise<string | null | undefined> {
  const base = sttUrl.pathname.endsWith("/") ? sttUrl.pathname.slice(0, -1) : sttUrl.pathname;
  const u = new URL(sttUrl.href);
  u.pathname = `${base}/inference`;
  const a = await loopbackRequest(u, { method: "OPTIONS", headers: { origin: CHECK_ORIGIN, "access-control-request-method": "POST" }, limit: 4096 });
  if (a === null) return undefined;
  const v = a.headers["access-control-allow-origin"];
  return v === undefined ? null : String(v);
}
