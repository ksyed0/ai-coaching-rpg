import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * US-0072 (review B2 F2): the process tests' guard around the REAL worktree's package.json, pnpm-lock.yaml and .env (the `update` trap,
 * K13). Only a sha256 digest of each file is kept (a missing file is `null`, never read), and a change fails with the changed file NAMES
 * only: the owner's real `.env` may hold secrets, and a diff of its contents in a failing assertion would print them.
 */
export type FileDigest = { name: string; digest: string | null };

export function digestFiles(files: string[]): FileDigest[] {
  return files.map((f) => ({ name: path.basename(f), digest: existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null }));
}

export function assertUnchanged(before: FileDigest[], after: FileDigest[]): void {
  const changed = before.filter((b, i) => after[i]?.name !== b.name || after[i]?.digest !== b.digest).map((b) => b.name);
  if (changed.length > 0) throw new Error(`the real worktree's files changed during the process tests: ${changed.join(", ")}`);
}
