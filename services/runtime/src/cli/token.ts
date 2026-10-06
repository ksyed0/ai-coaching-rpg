import { MAX_TOKEN_CHARS, MIN_TOKEN_CHARS, TOKEN_RULE, isValidToken } from "../host/security.js";

export type TokenResult = { ok: true; token: string | undefined; warnings: string[] } | { ok: false; error: string };

export type TokenDeps = {
  env: NodeJS.ProcessEnv;
  tokenFile?: string;
  /** Reads a file as text; throws on any error. */
  readFile(path: string): string;
  /** The file's permission bits (st_mode & 0o777), or undefined where unknown. */
  fileMode(path: string): number | undefined;
  isTTY: boolean;
  /** Asks for the token without echoing it. Resolves to what was typed (blank means "none"). */
  promptHidden(question: string): Promise<string>;
};

const SHAPE = `a token is ${MIN_TOKEN_CHARS} to ${MAX_TOKEN_CHARS} printable characters (${TOKEN_RULE})`;

/**
 * Where the facilitator token comes from, in this order: the FACILITATOR_TOKEN environment variable, --token-file, a hidden prompt on a
 * terminal. There is deliberately no command-line value (argv shows in `ps` and shell history). Messages never contain the token.
 * With none of the three the client joins without one, which works only against an open server.
 */
export async function resolveFacilitatorToken(d: TokenDeps): Promise<TokenResult> {
  const warnings: string[] = [];
  const fromEnv = d.env.FACILITATOR_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isValidToken(fromEnv)) return { ok: false, error: `error: FACILITATOR_TOKEN is not a valid token (${SHAPE}); the value is not shown` };
    return { ok: true, token: fromEnv, warnings };
  }
  if (d.tokenFile !== undefined) {
    let text: string;
    try { text = d.readFile(d.tokenFile); } catch { return { ok: false, error: "error: cannot read the --token-file" }; }
    const mode = d.fileMode(d.tokenFile);
    if (mode !== undefined && (mode & 0o077) !== 0) warnings.push(`warning: the --token-file is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
    const token = text.replace(/\r?\n$/, "");
    if (!isValidToken(token)) return { ok: false, error: `error: the --token-file does not hold a valid token (${SHAPE}); the contents are not shown` };
    return { ok: true, token, warnings };
  }
  if (d.isTTY) {
    const typed = (await d.promptHidden("facilitator token (press Enter if the server has none): ")).trim();
    if (typed === "") return { ok: true, token: undefined, warnings };
    if (!isValidToken(typed)) return { ok: false, error: `error: that is not a valid token (${SHAPE}); the value is not shown` };
    return { ok: true, token: typed, warnings };
  }
  return { ok: true, token: undefined, warnings };
}
