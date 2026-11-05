import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The directory the path is anchored under (the first allowed root containing it, else the filesystem root). Symlinks above it are the user's own layout. */
function anchorOf(target: string, anchors: string[]): string {
  return anchors.find((a) => within(a, target)) ?? path.parse(target).root;
}

/** Does `a` name the same file as `b`? Compares device and inode when both exist, else the real parent directory plus the file name. */
export async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  if (sa && sb) return sa.dev === sb.dev && sa.ino === sb.ino;
  const norm = async (p: string) => {
    const abs = path.resolve(p);
    const parent = await realpath(path.dirname(abs)).catch(() => path.dirname(abs));
    return path.join(parent, path.basename(abs));
  };
  return (await norm(a)) === (await norm(b));
}

/** The first existing directory component below the anchor that is a symbolic link, if any. */
async function symlinkedParent(target: string, anchors: string[]): Promise<boolean> {
  const anchor = anchorOf(target, anchors);
  const parts = path.relative(anchor, path.dirname(target)).split(path.sep).filter(Boolean);
  let cur = anchor;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (!st) return false; // nothing below can exist yet
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** Why `target` may not be written, or null. Used before anything starts (the write itself re-checks, see writeTranscriptFile). */
export async function checkTranscriptTarget(target: string, o: { base: string; repoRoot: string; jsonPath: string | undefined }): Promise<string | null> {
  const anchors = [o.base, o.repoRoot, os.tmpdir()];
  if ((await lstat(target).catch(() => null))?.isSymbolicLink()) return "that path is a symbolic link";
  if (await symlinkedParent(target, anchors)) return "a folder on that path is a symbolic link";
  if (o.jsonPath !== undefined && (await sameFile(target, o.jsonPath))) return "that is the same file as --json";
  if ((await stat(target).catch(() => null))?.isDirectory()) return "that path is a directory";
  if (!(await stat(path.dirname(target)).catch(() => null))?.isDirectory() && !anchors.some((a) => within(a, target))) {
    return "its folder does not exist and is outside the repo, the working directory and the temp directory";
  }
  return null;
}

/**
 * Writes the file without following a symbolic link at the final component (O_NOFOLLOW), after re-checking that no parent
 * folder below the anchor is a symbolic link. Missing parents are created. Throws on a link, so a swap after the start-up check
 * can never redirect the write.
 */
export async function writeTranscriptFile(target: string, text: string, o: { anchors?: string[] } = {}): Promise<void> {
  const anchors = o.anchors ?? [os.tmpdir(), process.cwd()];
  await mkdir(path.dirname(target), { recursive: true });
  if (await symlinkedParent(target, anchors)) throw new Error("a folder on the transcript path is a symbolic link");
  const fh = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try { await fh.writeFile(text, "utf8"); } finally { await fh.close(); }
}
