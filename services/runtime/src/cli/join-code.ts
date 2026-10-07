import { readTextCapped } from "@acr/script";
import { JOIN_CODE_ALPHABET, JOIN_CODE_SYMBOLS, MAX_JOIN_CODE_INPUT_CHARS, normalizeJoinCode } from "../engine/join-codes.js";

/** US-0033: where a player's join code comes from. Same rules as the facilitator token: never the command line, never printed. */
export type JoinCodeDeps = {
  env: NodeJS.ProcessEnv;
  codeFile?: string;
  /** The role being claimed (only to word the prompt). */
  role: string;
  readFile(path: string): string | Promise<string>;
  /** The file's permission bits (st_mode & 0o777), or undefined where unknown. */
  fileMode(path: string): number | undefined;
  isTTY: boolean;
  /** Asks without echoing. Resolves to what was typed (blank means "none"). */
  promptHidden(question: string): Promise<string>;
};
export type JoinCodeResult = { ok: true; code: string | undefined; warnings: string[] } | { ok: false; error: string };

const SHAPE = "a join code is 12 letters and digits, shown as XXXX-XXXX-XXXX (case, spaces and hyphens do not matter)";
const SYMBOLS = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_SYMBOLS}}$`);

/** Could this be a join code? (The server decides whether it is the right one.) */
export function isPlausibleJoinCode(raw: string): boolean {
  return raw.length <= MAX_JOIN_CODE_INPUT_CHARS && SYMBOLS.test(normalizeJoinCode(raw));
}

/**
 * The player's join code, in this order: the JOIN_CODE environment variable, --code-file, a hidden prompt on a terminal. There is
 * deliberately no command-line value (argv shows in `ps` and shell history). Messages never contain the code. With none of the
 * three the client joins without one (a server that issues codes then refuses the join with `unauthorized`).
 */
export async function resolveJoinCode(d: JoinCodeDeps): Promise<JoinCodeResult> {
  const warnings: string[] = [];
  const check = (raw: string, where: string): JoinCodeResult =>
    isPlausibleJoinCode(raw) ? { ok: true, code: raw.trim(), warnings } : { ok: false, error: `error: ${where} does not hold a valid join code (${SHAPE}); the value is not shown` };
  const fromEnv = d.env.JOIN_CODE;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return check(fromEnv, "JOIN_CODE");
  if (d.codeFile !== undefined) {
    let text: string;
    try { text = await d.readFile(d.codeFile); } catch { return { ok: false, error: "error: cannot read the --code-file (it must be a small regular file, at most 1 KiB)" }; }
    const mode = d.fileMode(d.codeFile);
    if (mode !== undefined && (mode & 0o077) !== 0) warnings.push(`warning: the --code-file is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
    return check(text.replace(/\r?\n$/, ""), "the --code-file");
  }
  if (d.isTTY) {
    const typed = (await d.promptHidden(`join code for ${d.role} (from the facilitator; press Enter if the server needs none): `)).trim();
    if (typed === "") return { ok: true, code: undefined, warnings };
    return check(typed, "that");
  }
  return { ok: true, code: undefined, warnings };
}

export const CODE_FILE_MAX_BYTES = 1024;
export const readCodeFile = (file: string): Promise<string> => readTextCapped(file, CODE_FILE_MAX_BYTES);
