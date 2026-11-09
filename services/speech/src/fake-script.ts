import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { FakeSpeechToText, type SpeechToText } from "@acr/adapters";
import { isReservedRoleId, isScenarioId } from "@acr/events";
import { MAX_VOICE_TEXT_CHARS } from "./protocol.js";

/** The one sentence an unusable STT_FAKE_SCRIPT is refused with (names the variable, never the path). */
export const FAKE_SCRIPT_REFUSED = "STT_FAKE_SCRIPT is not a readable fake script (a JSON object of role ids to lists of lines)";
const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * US-0070: the scripted speech-to-text of the offline demo and the process tests (STT_PROVIDER=fake), like the mock model provider. The
 * script is `{ "<roleId>": ["line 1", ...] }`: a role's n-th segment gets its n-th line, and "" (an empty segment) after the last. Every
 * call is appended to `<script>.calls.jsonl` (owner-only) as `{"roleId": "...", "n": 1}`: role and ordinal only, never text, so the demo
 * can prove which seats were sent to STT at all (check V-04).
 */
export function parseFakeScript(raw: unknown): Map<string, string[]> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out = new Map<string, string[]>();
  for (const [roleId, lines] of Object.entries(raw)) {
    if (!isScenarioId(roleId) || isReservedRoleId(roleId)) return null;
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string" && l.length <= MAX_VOICE_TEXT_CHARS)) return null;
    out.set(roleId, [...(lines as string[])]);
  }
  return out;
}

export function loadFakeScript(file: string): { sttFor(roleId: string): SpeechToText } {
  let text: string;
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new Error(FAKE_SCRIPT_REFUSED); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) throw new Error(FAKE_SCRIPT_REFUSED);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    text = buf.subarray(0, off).toString("utf8");
  } catch { throw new Error(FAKE_SCRIPT_REFUSED); }
  finally { closeSync(fd); }
  let script: Map<string, string[]> | null;
  try { script = parseFakeScript(JSON.parse(text)); } catch { script = null; }
  if (!script) throw new Error(FAKE_SCRIPT_REFUSED);
  const lines = script;
  const callsFile = `${file}.calls.jsonl`;
  const counts = new Map<string, number>();
  const made = new Map<string, SpeechToText>();
  const record = (roleId: string, n: number): void => {
    const fd2 = openSync(callsFile, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd2, 0o600); writeSync(fd2, `${JSON.stringify({ roleId, n })}\n`); } finally { closeSync(fd2); }
  };
  return {
    sttFor(roleId) {
      let stt = made.get(roleId);
      if (!stt) {
        stt = new FakeSpeechToText({
          script: () => {
            const n = (counts.get(roleId) ?? 0) + 1;
            counts.set(roleId, n);
            record(roleId, n);
            return { text: lines.get(roleId)?.[n - 1] ?? "", durationMs: 1, noSpeechProb: 0.01, avgLogprob: -0.1 };
          },
        });
        made.set(roleId, stt);
      }
      return stt;
    },
  };
}
