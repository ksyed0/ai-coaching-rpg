import { tlsRouteAnswers, type TlsConnect } from "../tls-route.js";
import type { CheckResult } from "./types.js";

/** US-0072 (EPIC-0003 voice A1c, Task 8): Task 7's `tlsRouteAnswers` (system CA store included) as a check result. */
export async function tlsRouteCheck(o: { hostname: string; port: number; connect: TlsConnect; address?: string }): Promise<CheckResult> {
  const at = `https://${o.hostname}:${o.port}/rtc`;
  return (await tlsRouteAnswers(o))
    ? { name: "tls-route", level: "ok", line: `the TLS route ${at} answers with a trusted certificate` }
    : { name: "tls-route", level: "fail", line: `the TLS route ${at} does not answer with a trusted certificate: check the certificate, DNS and docker compose -p scenecoach-voice logs caddy` };
}
