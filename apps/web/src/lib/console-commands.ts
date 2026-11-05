"use client";

import { useCallback, useRef, useState } from "react";
import { postJson } from "./api";
import type { ApiResult } from "./api";
import { CONSOLE_COPY, failureText } from "./console-api";

// US-0059: the browser side of the facilitator controls. One command at a time; a command is never retried (a refusal after a wait is
// indistinguishable from success on a second try, so the facilitator reads the live view and decides). The BFF's message is shown as
// text; the status copy stands in when it is empty (postJson blanks a message over 300 characters).

/** A mirror of the BFF's list (a lib module may not import a server one); a server test asserts they are equal. */
export const COMMAND_KINDS = [
  "pause",
  "resume",
  "advance",
  "fire_inject",
  "whisper",
  "release_hidden",
  "set_npc_stance",
  "end_now",
] as const;

export type ConsoleCommand =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "advance"; expectSceneId?: string }
  | { kind: "fire_inject"; injectId: string; expectSceneId?: string }
  | { kind: "whisper"; roleId: string; text: string; expectSceneId?: string }
  | {
      kind: "release_hidden";
      roleId: string;
      fact: number;
      expectSceneId?: string;
    }
  | {
      kind: "set_npc_stance";
      roleId: string;
      goals: string[];
      expectSceneId?: string;
    }
  | { kind: "end_now"; message?: string };

export type ConsoleFactText = {
  roleId: string;
  facts: { n: number; text: string }[];
};

const base = (sessionId: string) =>
  `/api/v1/console/sessions/${encodeURIComponent(sessionId)}`;
export const commandUrl = (sessionId: string): string =>
  `${base(sessionId)}/command`;
export const factsUrl = (sessionId: string): string =>
  `${base(sessionId)}/facts`;

export function sendCommand(
  sessionId: string,
  channel: string,
  c: ConsoleCommand,
  fetchImpl?: typeof fetch,
): Promise<ApiResult> {
  return postJson(commandUrl(sessionId), { channel, ...c }, fetchImpl);
}

function refusal(r: Extract<ApiResult, { ok: false }>): string {
  if (r.status === 0) return CONSOLE_COPY.unreachable;
  if (r.status === 401) return CONSOLE_COPY.signedOut;
  return r.message !== "" ? r.message : failureText(r);
}

function toFacts(data: unknown): ConsoleFactText[] | null {
  const roles = (data as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles)) return null;
  const out: ConsoleFactText[] = [];
  for (const r of roles) {
    const o = r as { roleId?: unknown; facts?: unknown } | null;
    if (typeof o?.roleId !== "string" || !Array.isArray(o.facts)) return null;
    const facts: ConsoleFactText["facts"] = [];
    for (const f of o.facts) {
      const x = f as { n?: unknown; text?: unknown } | null;
      if (typeof x?.n !== "number" || typeof x.text !== "string") return null;
      facts.push({ n: x.n, text: x.text });
    }
    out.push({ roleId: o.roleId, facts });
  }
  return out;
}

export async function fetchFacts(
  sessionId: string,
  channel: string,
  fetchImpl?: typeof fetch,
): Promise<
  { ok: true; roles: ConsoleFactText[] } | { ok: false; message: string }
> {
  const r = await postJson(factsUrl(sessionId), { channel }, fetchImpl);
  if (!r.ok) return { ok: false, message: refusal(r) };
  const roles = toFacts(r.data);
  return roles
    ? { ok: true, roles }
    : {
        ok: false,
        message: failureText({
          ok: false,
          status: 500,
          code: "unknown",
          message: "",
        }),
      };
}

const ANNOUNCE: Record<ConsoleCommand["kind"], string | null> = {
  pause: "Paused.",
  resume: "Resumed.",
  advance: "Moving on to the next scene.",
  fire_inject: "Inject fired.",
  whisper: "Whisper sent.",
  release_hidden: "Fact released.",
  set_npc_stance: "Stance changed.",
  end_now: null, // the stream's "ended" final is announced once by the page
};

export function useConsoleCommands(
  sessionId: string,
  channel: string | null,
  fetchImpl?: typeof fetch,
) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (c: ConsoleCommand): Promise<boolean> => {
      if (busy.current || channel === null) return false;
      busy.current = true;
      setPending(true);
      setStatus(null);
      setError(null);
      try {
        const r = await sendCommand(sessionId, channel, c, fetchImpl);
        if (r.ok) {
          setStatus(ANNOUNCE[c.kind]);
          return true;
        }
        setError(refusal(r));
        return false;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [sessionId, channel, fetchImpl],
  );

  return { pending, status, error, run };
}
