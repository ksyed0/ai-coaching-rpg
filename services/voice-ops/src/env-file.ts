import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { parseSttUrl } from "@acr/adapters";
import { isLiveKitToken, isRequestPath } from "./text.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 2): `pnpm voice:up` generates the LiveKit key and secret and `STT_URL` into the ROOT `.env` (the
 * only file control reads, R2) once. Nothing here prints or logs a value, and nothing here passes one in an argument list. The key and
 * the secret never reach any argument list; the STT request path does, by design, in exactly one place: whisper-server's own
 * `--request-path` (plan K14, Task 4 `whisperArgs`), where local processes can read it with `ps`.
 *
 * - Only names that are absent are added, as one appended block; an existing byte is never changed: the file is copied as the bytes the
 *   read saw (a decoded copy is used only to decide), so a byte that is not valid UTF-8 survives (review A F1).
 * - The file is read through one descriptor opened with O_NOFOLLOW and judged by fstat: a regular file owned by this user, with no group
 *   or other permission bits and one hard link. A symlink, a second hard link, a directory, another owner, mode 0644, a file over 1 MiB
 *   and a missing file are refused (a missing `.env` is NOT created: `run.sh` gives a facilitator token only to a NEW `.env`, so a `.env`
 *   made here would leave the server open). The mode check sees mode bits only, not ACLs or extended attributes (plan Task 15 residual).
 * - It is replaced atomically: an O_EXCL temp beside it, set to 0600 whatever the umask, fsync; then the path is lstat'ed and its dev,
 *   ino, size, mtimeMs, ctimeMs and nlink are compared with what the read descriptor saw (any change, or a link now, aborts with the
 *   file left alone); rename; fsync the directory.
 * - Refused with the file unchanged byte for byte: half a key pair, an empty assignment of a managed name, the public development keys
 *   (`devkey` / `secret`, any case, or a secret under 32 characters), a key or secret outside control's rule or holding a character that
 *   would break `livekit.env` or LiveKit's key map (`bad_keys`), an `STT_URL` that whisper-server cannot serve, a `.env` tracked by
 *   git (or git not answering in time), and a REAL environment that sets a managed name (control merges `.env` UNDER the real
 *   environment, so a shell export would give control, LiveKit and whisper-server different values: finding 7).
 *
 * Every error is an EnvFileError with a fixed sentence per code that names variables only, never a value or a path.
 */

export const MANAGED_NAMES = ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "STT_URL"] as const;
/**
 * The shortest STT request path voice-ops accepts, in characters after the leading slash (batch 2 review B F10). whisper-server sends a
 * CORS header, so a web page that finds the port could POST to /inference and /load on loopback; the path is what keeps it out. The
 * generated path is 32 hex characters.
 */
export const MIN_STT_PATH_CHARS = 16;
/** Whether an STT request path (`sttRequestPath`: leading slash, no trailing slash) is long enough (MIN_STT_PATH_CHARS). */
export const isLongRequestPath = (p: string): boolean => p.startsWith("/") && p.length - 1 >= MIN_STT_PATH_CHARS;
export type ManagedName = (typeof MANAGED_NAMES)[number];

export type EnvFileErrorCode =
  | "missing" | "symlink" | "not_regular" | "not_owner" | "linked" | "too_open" | "unreadable" | "too_large" | "unwritable" | "dev_keys" | "half_pair" | "empty_assignment"
  | "bad_keys" | "bad_stt_url" | "short_stt_path" | "changed" | "env_override" | "tracked" | "git_timeout";

const SENTENCES: Record<EnvFileErrorCode, (name: ManagedName | undefined) => string> = {
  missing: () => ".env not found: run ./run.sh once first (it creates .env with a facilitator token), then pnpm voice:up",
  symlink: () => ".env is a symbolic link: voice:up never writes through a link; replace it with a regular file (mode 600), then pnpm voice:up",
  not_regular: () => ".env is not a regular file: replace it with a regular file (mode 600), then pnpm voice:up",
  not_owner: () => ".env belongs to another user: voice:up writes only a .env that you own",
  linked: () => ".env has more than one hard link: voice:up would replace only this name; make .env a single file (cp .env .env.new, chmod 600 .env.new, mv .env.new .env), then pnpm voice:up",
  too_open: () => ".env is readable by other users: run chmod 600 .env, then pnpm voice:up",
  unreadable: () => ".env cannot be opened, read or parsed: check its permissions and its syntax by hand, then pnpm voice:up",
  too_large: () => ".env is larger than 1 MiB: voice:up reads only a smaller .env; check it by hand, then pnpm voice:up",
  unwritable: () => ".env could not be written: check that its folder is writable and the disk has room, then pnpm voice:up (it adds only what is still missing)",
  dev_keys: () => ".env holds LiveKit development keys (devkey/secret, or a secret under 32 characters): remove LIVEKIT_API_KEY and LIVEKIT_API_SECRET so voice:up generates real ones",
  half_pair: () => ".env sets only one of LIVEKIT_API_KEY and LIVEKIT_API_SECRET: set both, or remove both so voice:up generates them",
  empty_assignment: (name) => `.env assigns an empty value to ${name ?? "a managed name"}: remove that line or give it a value, then pnpm voice:up`,
  bad_keys: (name) => `.env sets a ${name ?? "LiveKit key or secret"} that LiveKit's key list cannot hold: use printable characters without space, quotes, backslash or any of : , # $ { } [ ] & * ! | > % @ ? (key 1 to 256, secret 32 to 512), or remove LIVEKIT_API_KEY and LIVEKIT_API_SECRET so voice:up generates them`,
  bad_stt_url: () => ".env sets an STT_URL whisper-server cannot serve: use http://127.0.0.1:<port>/<path> with a port from 1 to 65535 and a path of letters, digits, - . _ ~ and single slashes (whisper-server binds 127.0.0.1 only), or remove it so voice:up picks one",
  short_stt_path: () => `.env sets an STT_URL whose request path is empty or shorter than ${MIN_STT_PATH_CHARS} characters: whisper-server answers requests from any web page (its CORS header), and the path is what keeps a page that finds the port out; use http://127.0.0.1:<port>/<at least ${MIN_STT_PATH_CHARS} letters or digits>, or remove STT_URL so voice:up generates one`,
  changed: () => ".env changed while voice:up was writing it: run pnpm voice:up again",
  env_override: (name) => `unset ${name ?? "the managed names"} in this shell: voice:up and control must read it from .env`,
  tracked: () => "remove .env from git (git rm --cached .env) before voice:up writes secrets into it",
  git_timeout: () => "git did not answer in time whether .env is tracked: check the repository with git status, then pnpm voice:up",
};

/** A refused `.env`. The message is a fixed sentence for the code, naming at most one managed variable; never a value or a path. */
export class EnvFileError extends Error {
  constructor(readonly code: EnvFileErrorCode, name?: ManagedName) {
    super(SENTENCES[code](name));
    this.name = "EnvFileError";
  }
}

/**
 * Runs a file-system step; any error that is not already an EnvFileError becomes `EnvFileError(code)`. The raw Node error is dropped on
 * purpose (no `cause`): its message names the path, and a rename error names both paths (review A F3).
 */
function guard<T>(code: EnvFileErrorCode, fn: () => T): T {
  try { return fn(); } catch (err) { if (err instanceof EnvFileError) throw err; throw new EnvFileError(code); }
}

/** The identity of the file the read descriptor saw; compared with an lstat of the path right before the rename. */
export type FileId = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number };

/** The command runner seam (Task 3's `Run` has this shape). Only `git ls-files` runs through it here. */
export type GitRun = (cmd: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const MAX_ENV_BYTES = 1024 * 1024;
export const STT_PORT_MIN = 20000;
export const STT_PORT_MAX = 32767;
const KEY_PREFIX = "API";
const SECRET_MIN_CHARS = 32;
const KEY_MAX_CHARS = 256; // control's limits (services/control/src/voice/livekit-config.ts)
const SECRET_MAX_CHARS = 512;

/**
 * Reads `.env` through ONE descriptor (O_RDONLY | O_NOFOLLOW) and judges it by fstat. `uid` is the owner it must have (default this
 * process's uid; injectable so the `not_owner` refusal is tested without root). Throws EnvFileError.
 */
export function readPrivateEnv(file: string, o: { uid?: number } = {}): { bytes: Buffer; text: string; values: Record<string, string>; id: FileId } {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new EnvFileError("missing");
    if (code === "ELOOP" || code === "EMLINK") throw new EnvFileError("symlink");
    throw new EnvFileError("unreadable");
  }
  try {
    const st = guard("unreadable", () => fstatSync(fd));
    if (!st.isFile()) throw new EnvFileError("not_regular");
    const uid = o.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && st.uid !== uid) throw new EnvFileError("not_owner");
    if (st.nlink > 1) throw new EnvFileError("linked"); // the rename would leave the other name with the old bytes (as readSecureJson refuses)
    if ((st.mode & 0o077) !== 0) throw new EnvFileError("too_open");
    if (st.size > MAX_ENV_BYTES) throw new EnvFileError("too_large");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = guard("unreadable", () => readSync(fd, buf, off, buf.length - off, off)); if (n === 0) break; off += n; }
    if (off !== st.size) throw new EnvFileError("changed"); // it shrank while being read
    const text = buf.toString("utf8");
    let values: Record<string, string>;
    try { values = parseEnv(text) as Record<string, string>; } catch { throw new EnvFileError("unreadable"); }
    return { bytes: buf, text, values, id: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, nlink: st.nlink } };
  } finally {
    try { closeSync(fd); } catch { /* a read-only descriptor: a failed close loses nothing that was read */ }
  }
}

/** The length of a leading `export` plus blanks (after leading blanks), or 0 when the line has none. */
function exportPrefix(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (!line.startsWith("export", i)) return 0;
  let j = i + "export".length;
  if (j >= line.length || (line[j] !== " " && line[j] !== "\t")) return 0;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
  return j;
}

/**
 * Assignments of managed names, line by line, so an empty line that a later line overrides is still seen. An `export ` prefix is
 * dropped first: Node 22's parseEnv keeps it in the NAME when the value is empty (`export STT_URL=` gives the name `export STT_URL`),
 * while a shell or another dotenv reader sees STT_URL empty; either way an appended second line could win or lose.
 */
function emptyAssignment(text: string): ManagedName | null {
  for (const raw of text.split("\n")) {
    const noCr = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let line: Record<string, string>;
    try { line = parseEnv(noCr.slice(exportPrefix(noCr))) as Record<string, string>; } catch { continue; }
    for (const name of MANAGED_NAMES) if (Object.hasOwn(line, name) && line[name]!.trim() === "") return name;
  }
  return null;
}

/** What makes the managed names in `.env` unusable, or null. Never looks at anything but the three managed names. */
function managedProblem(text: string, values: Record<string, string>): { code: EnvFileErrorCode; name?: ManagedName } | null {
  const empty = emptyAssignment(text) ?? MANAGED_NAMES.find((n) => Object.hasOwn(values, n) && values[n]!.trim() === "") ?? null;
  if (empty) return { code: "empty_assignment", name: empty };
  const has = (n: ManagedName): boolean => Object.hasOwn(values, n);
  if (has("LIVEKIT_API_KEY") !== has("LIVEKIT_API_SECRET")) return { code: "half_pair" };
  if (has("LIVEKIT_API_KEY")) {
    const key = values.LIVEKIT_API_KEY!;
    const secret = values.LIVEKIT_API_SECRET!;
    if (key.toLowerCase() === "devkey" || secret.toLowerCase() === "secret" || secret.length < SECRET_MIN_CHARS) return { code: "dev_keys" };
    if (!isLiveKitToken(key, 1, KEY_MAX_CHARS)) return { code: "bad_keys", name: "LIVEKIT_API_KEY" };
    if (!isLiveKitToken(secret, SECRET_MIN_CHARS, SECRET_MAX_CHARS)) return { code: "bad_keys", name: "LIVEKIT_API_SECRET" };
  }
  if (has("STT_URL")) {
    const u = parseSttUrl(values.STT_URL);
    // Beyond parseSttUrl (review A F7): host 127.0.0.1 only (whisper-server binds no other), port 1..65535 (the parser lets 0 through),
    // and a path both sides agree on (isRequestPath: no `//`, no percent-encoding).
    if (!u.ok || u.url.hostname !== "127.0.0.1") return { code: "bad_stt_url" };
    const port = Number(u.url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !isRequestPath(u.url.pathname)) return { code: "bad_stt_url" };
    // Review B F10: a hand-set STT_URL with an empty or short path is refused (K2 made it a warning only).
    if (!isLongRequestPath(sttRequestPath(u.url))) return { code: "short_stt_path" };
  }
  return null;
}

function hexOf(random: (n: number) => Buffer, n: number): string {
  const b = random(n);
  if (!Buffer.isBuffer(b) || b.length !== n) throw new Error("the random source returned the wrong number of bytes");
  return b.toString("hex");
}

/**
 * Which managed names to add, with generated values, or why `.env` is refused. `freePort` is used only when STT_URL is generated and must
 * then be in 20000..32767 (below the macOS and Linux ephemeral ranges). The key and the secret are always planned together.
 */
export function planSecrets(text: string, values: Record<string, string>, o: { random: (n: number) => Buffer; freePort: number }):
  { ok: true; add: { name: ManagedName; value: string }[] } | { ok: false; code: EnvFileErrorCode } {
  const problem = managedProblem(text, values);
  if (problem) return { ok: false, code: problem.code };
  const add: { name: ManagedName; value: string }[] = [];
  if (!Object.hasOwn(values, "LIVEKIT_API_KEY")) {
    add.push({ name: "LIVEKIT_API_KEY", value: KEY_PREFIX + hexOf(o.random, 12) });
    add.push({ name: "LIVEKIT_API_SECRET", value: hexOf(o.random, 32) });
  }
  if (!Object.hasOwn(values, "STT_URL")) {
    if (!Number.isInteger(o.freePort) || o.freePort < STT_PORT_MIN || o.freePort > STT_PORT_MAX) throw new Error(`the STT port must be from ${STT_PORT_MIN} to ${STT_PORT_MAX}`);
    add.push({ name: "STT_URL", value: `http://127.0.0.1:${o.freePort}/${hexOf(o.random, 16)}` });
  }
  return { ok: true, add };
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, fsConstants.O_RDONLY); fsyncSync(fd); }
  catch (err) { if (!["EISDIR", "EINVAL", "EPERM", "EBADF", "ENOTSUP", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw new EnvFileError("unwritable"); }
  finally { if (fd !== null) closeSync(fd); }
}

/**
 * Writes `bytes` (the file as read, unchanged; plus a newline if it does not end with one) and `block` to a new O_EXCL 0600 temp file
 * beside `file`, fsyncs it, then replaces `file` with it only if the path is still the file the read saw (`readId`). The temp is removed
 * on every failure. `random` names the temp file (default `randomBytes`; injectable so a test can pre-create that name).
 */
export function appendBlock(file: string, bytes: Buffer, block: string, readId: FileId, o: { random?: (n: number) => Buffer } = {}): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.env.voice-ops.${hexOf(o.random ?? randomBytes, 6)}.tmp`);
  const needsNewline = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  const data = Buffer.concat([bytes, Buffer.from((needsNewline ? "\n" : "") + block, "utf8")]);
  // Not created when this throws (EEXIST included): nothing to remove, and a file of that name that is not ours is left alone.
  const fd = guard("unwritable", () => openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600));
  try {
    try {
      guard("unwritable", () => {
        fchmodSync(fd, 0o600); // the umask may have removed owner bits from the 0600 of the open (umask 0477 gives 0200): review A F6
        let off = 0;
        while (off < data.length) off += writeSync(fd, data, off, data.length - off);
        fsyncSync(fd);
      });
    } finally { guard("unwritable", () => closeSync(fd)); }
    let now: ReturnType<typeof lstatSync>;
    try { now = lstatSync(file); } catch { throw new EnvFileError("changed"); }
    // ctime too (review A F8): `utimes` can put mtime back after a same-size write, never ctime; and nlink, so a link made after the read
    // (whose other name would keep the old bytes) aborts as well.
    if (!now.isFile() || now.dev !== readId.dev || now.ino !== readId.ino || now.size !== readId.size || now.mtimeMs !== readId.mtimeMs
      || now.ctimeMs !== readId.ctimeMs || now.nlink !== readId.nlink || now.nlink !== 1) {
      throw new EnvFileError("changed");
    }
    guard("unwritable", () => renameSync(tmp, file));
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already renamed or never created */ }
    throw err;
  }
  fsyncDir(dir);
}

/** whisper-server's `--request-path` for an STT_URL: its pathname without trailing slashes; "" for none (refused: `isLongRequestPath`). */
export function sttRequestPath(sttUrl: URL): string {
  let p = sttUrl.pathname;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Whether git tracks `.env` (review A F4). `git -C <dir> ls-files -z -- ':(icase).env'`: exit 0 with any output = tracked; the pathspec
 * ignores case, because on a case-insensitive file system (macOS) a tracked `.ENV` IS this file (on Linux it is another file, and the
 * refusal is merely cautious). git runs with every `GIT_*` variable removed from `env`, so an inherited GIT_DIR or GIT_WORK_TREE cannot
 * point the question at another repository. A run that was killed (`code` null: the timeout) is refused; git missing (a throw), not a
 * repository (128) or any other exit skips the check.
 */
export async function trackedByGit(run: GitRun, dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const gitEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_")) gitEnv[k] = v;
  let r: Awaited<ReturnType<GitRun>>;
  try { r = await run("git", ["-C", dir, "ls-files", "-z", "--", ":(icase).env"], { env: gitEnv, timeoutMs: 30_000 }); }
  catch { return false; }
  if (r.code === null) throw new EnvFileError("git_timeout");
  return r.code === 0 && r.stdout !== "";
}

/**
 * Adds the managed names `.env` lacks. Order: the real environment (a managed name set there is refused), git (a tracked `.env` is
 * refused), the read and its checks, then `freePort` (only when STT_URL is generated), then the atomic append. Returns the added NAMES
 * only. Prints nothing; the caller (Task 7) prints "added to .env: <names>" and re-reads the merged view with `loadRootEnv`.
 */
export async function ensureVoiceSecrets(o: {
  file: string; random: (n: number) => Buffer; freePort: () => Promise<number>; now: () => number; env: NodeJS.ProcessEnv; run: GitRun;
}): Promise<{ added: string[] }> {
  for (const name of MANAGED_NAMES) if (o.env[name] !== undefined) throw new EnvFileError("env_override", name);
  if (await trackedByGit(o.run, path.dirname(o.file), o.env)) throw new EnvFileError("tracked");
  const r = readPrivateEnv(o.file);
  const problem = managedProblem(r.text, r.values);
  if (problem) throw new EnvFileError(problem.code, problem.name);
  const port = Object.hasOwn(r.values, "STT_URL") ? 0 : await o.freePort();
  const plan = planSecrets(r.text, r.values, { random: o.random, freePort: port });
  if (!plan.ok) throw new EnvFileError(plan.code);
  if (plan.add.length === 0) return { added: [] };
  const date = new Date(o.now()).toISOString().slice(0, 10);
  // The block holds no quote character, so it can never close a quote the existing text left open (parseEnv reads such a quote literally).
  const block = `# Added by pnpm voice:up on ${date} (US-0072). Secrets: keep this file private (mode 600), never commit it.\n`
    + plan.add.map((a) => `${a.name}=${a.value}\n`).join("");
  appendBlock(o.file, r.bytes, block, r.id);
  return { added: plan.add.map((a) => a.name) };
}
