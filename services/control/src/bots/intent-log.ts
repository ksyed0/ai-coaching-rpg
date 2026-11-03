import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isValidSessionId } from "@acr/events";
import { RoleIdSchema } from "../protocol.js";

/**
 * US-0060: the facilitator-facing record of why an AI player spoke, skipped or dropped a turn. One JSONL file per session and role under
 * the control data dir (`intents/`, 0700; files 0600, opened O_APPEND|O_CREAT|O_NOFOLLOW). Logging never breaks a turn: append and
 * remove never throw.
 */
export const MAX_INTENT_FILE_BYTES = 256 * 1024;
export const MAX_INTENTS_RETURNED = 50;
const MAX_HINT_CHARS = 500;

export const IntentEntrySchema = z.object({
  ts: z.number().finite(),
  sceneId: z.string().max(128).nullable(),
  trigger: z.enum(["reply", "nudge", "prompt"]),
  outcome: z.enum(["spoken", "skipped", "dropped"]),
  reason: z.enum(["model_failed", "timeout", "unusable", "budget"]).optional(),
  hint: z.string().max(MAX_HINT_CHARS).optional(),
});
export type IntentEntry = z.infer<typeof IntentEntrySchema>;

const SUFFIX = ".jsonl";

/** `<sessionId>.<roleId>.jsonl`, built only from a valid session id and role id (so never a path component of its own). */
export function intentFileName(sessionId: string, roleId: string): string {
  if (typeof sessionId !== "string" || typeof roleId !== "string" || !isValidSessionId(sessionId) || !RoleIdSchema.safeParse(roleId).success) throw new Error("not an intent file");
  const name = `${sessionId}.${roleId}${SUFFIX}`;
  if (path.basename(name) !== name) throw new Error("not an intent file");
  return name;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : "error");

export class IntentLog {
  constructor(private readonly dir: string, private readonly log: (m: string) => void = () => {}) {}

  append(sessionId: string, roleId: string, e: IntentEntry): void {
    let fd: number | undefined;
    try {
      const file = path.join(this.dir, intentFileName(sessionId, roleId));
      const line = JSON.stringify(IntentEntrySchema.parse(e)) + "\n";
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size + Buffer.byteLength(line) > MAX_INTENT_FILE_BYTES) return;
      writeSync(fd, line);
    } catch (err) {
      this.log(`intent log append failed: ${errName(err)}`);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
    }
  }

  /** The last MAX_INTENTS_RETURNED valid entries, oldest first; a corrupt line is skipped; a missing or unreadable file gives []. */
  read(sessionId: string, roleId: string): IntentEntry[] {
    let fd: number | undefined;
    try {
      const file = path.join(this.dir, intentFileName(sessionId, roleId));
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 4 * MAX_INTENT_FILE_BYTES) return [];
      const out: IntentEntry[] = [];
      for (const line of readFileSync(fd, "utf8").split("\n")) {
        if (line === "") continue;
        try {
          const r = IntentEntrySchema.safeParse(JSON.parse(line));
          if (r.success) out.push(r.data);
        } catch { /* a corrupt line is skipped */ }
      }
      return out.slice(-MAX_INTENTS_RETURNED);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`intent log read failed: ${errName(err)}`);
      return [];
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
    }
  }

  /** Deletes one role's file, or with no role every file of the session. Never throws. */
  remove(sessionId: string, roleId?: string): void {
    try {
      if (roleId !== undefined) { this.unlink(intentFileName(sessionId, roleId)); return; }
      if (!isValidSessionId(sessionId)) return;
      for (const name of readdirSync(this.dir)) {
        if (!name.startsWith(`${sessionId}.`) || !name.endsWith(SUFFIX)) continue;
        const role = name.slice(sessionId.length + 1, -SUFFIX.length);
        if (RoleIdSchema.safeParse(role).success) this.unlink(name);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`intent log remove failed: ${errName(err)}`);
    }
  }

  private unlink(name: string): void {
    try { unlinkSync(path.join(this.dir, name)); } catch (err) { if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`intent log remove failed: ${errName(err)}`); }
  }
}
