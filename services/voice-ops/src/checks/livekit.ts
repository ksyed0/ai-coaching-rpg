import { httpAnswers } from "@acr/adapters";
import type { CheckResult } from "./types.js";

/** US-0072 (EPIC-0003 voice A1c, Task 8): does LiveKit's API answer HTTP on LIVEKIT_HOST? `httpAnswers` only: nothing is granted or minted. */
export async function livekitCheck(o: { host: URL; answers?: (url: string) => Promise<boolean> }): Promise<CheckResult> {
  const at = `${o.host.hostname}:${o.host.port}`;
  return (await (o.answers ?? ((u: string) => httpAnswers(u)))(o.host.href))
    ? { name: "livekit", level: "ok", line: `LiveKit answers on ${at}` }
    : { name: "livekit", level: "fail", line: `LiveKit does not answer on ${at}: run pnpm voice:up` };
}
