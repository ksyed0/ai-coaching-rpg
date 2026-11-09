import { dockerBaseEnv } from "../compose.js";
import type { Run } from "../run.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): versions, for the room-test record. whisper-server's from its resolved Homebrew path
 * (`.../Cellar/<formula>/<version>/bin/whisper-server`, "unknown" otherwise); Docker's and Compose's from the docker CLI (only when
 * Docker passed `dockerProblem`: a remote engine is never asked), with PATH, HOME and DOCKER_* only; the LiveKit and Caddy tags from
 * voice.yml; Node's.
 */
export function whisperVersionOf(realPath: string | null): string {
  if (realPath === null) return "unknown";
  const parts = realPath.split("/");
  const i = parts.indexOf("Cellar");
  const v = i >= 0 ? parts[i + 2] : undefined;
  return v !== undefined && v !== "" && [...v].every((c) => (c >= "0" && c <= "9") || c === "." || c === "_") ? v : "unknown";
}

/** The tag of `image: <name>:<tag>@sha256:...` in voice.yml, or "unknown". */
export function imageTag(composeText: string | null, name: string): string {
  for (const raw of (composeText ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`image: ${name}:`)) continue;
    const rest = line.slice(`image: ${name}:`.length);
    const tag = rest.split("@")[0]!.trim();
    return tag === "" ? "unknown" : tag;
  }
  return "unknown";
}

export async function versionsCheck(o: { run: Run; env: NodeJS.ProcessEnv; docker: boolean; modelLabel: string; whisperPath: string | null; composeText: string | null; node: string }): Promise<CheckResult> {
  const ask = async (args: string[]): Promise<string> => {
    if (!o.docker) return "unknown";
    try { const r = await o.run("docker", args, { env: dockerBaseEnv(o.env), timeoutMs: 30_000 }); const v = r.stdout.trim(); return r.code === 0 && v !== "" && v.length <= 64 ? v : "unknown"; }
    catch { return "unknown"; }
  };
  const docker = await ask(["version", "--format", "{{.Server.Version}}"]);
  const compose = await ask(["compose", "version", "--short"]);
  return {
    name: "versions", level: "ok",
    line: `versions: whisper-server ${whisperVersionOf(o.whisperPath)}, model ${o.modelLabel}, Docker ${docker}, Compose ${compose}, LiveKit ${imageTag(o.composeText, "livekit/livekit-server")}, Caddy ${imageTag(o.composeText, "caddy")}, Node ${o.node}`,
  };
}
