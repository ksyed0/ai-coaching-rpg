import { parseArgs as nodeParseArgs } from "node:util";
import { isValidSessionId } from "../engine/event-log.js";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 20;

export const DEMO_USAGE = [
  "usage: pnpm demo [--fast] [--speed <x>] [--json <path|->] [--live] [--url <ws://host:port>] [--session <id>] [--no-color] [--help]",
  `  --fast            no pacing delays (instant narration)`,
  `  --speed <x>       scale the pacing, ${MIN_SPEED} to ${MAX_SPEED} (default 1; 2 is twice as fast)`,
  "  --json <path|->   write a machine-readable report to a file, or to stdout with - (narration then goes to stderr;",
  "                    run `pnpm -s demo ...` so pnpm's own banner stays out of stdout)",
  "  --live            use the real configured model provider (sends text to it, may cost money)",
  "  --url <ws://...>  smoke-test an already running server instead of starting one",
  "  --session <id>    session id (default: demo, or local with --url)",
  "  --no-color        plain output (also: NO_COLOR, or output that is not a terminal)",
].join("\n");

export type DemoOptions = {
  fast: boolean; speed: number; json: string | undefined; live: boolean; url: string | undefined;
  session: string | undefined; noColor: boolean; help: boolean;
};
export type DemoArgsResult = { ok: true; opts: DemoOptions } | { ok: false; error: string; usage: string };

const fail = (error: string): DemoArgsResult => ({ ok: false, error, usage: DEMO_USAGE });
const FLAGS = ["fast", "speed", "json", "live", "url", "session", "no-color", "help"];
const hasControl = (v: string) => new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(v);

/** Validates a --url value. The error never echoes the value (it may carry credentials). */
export function checkWsUrl(raw: string): string | null {
  if (hasControl(raw) || /\s/.test(raw)) return "error: --url must be a plain ws:// or wss:// URL (no spaces or control characters)";
  let u: URL;
  try { u = new URL(raw); } catch { return "error: --url must be a ws:// or wss:// URL"; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return "error: --url must be a ws:// or wss:// URL";
  if (!u.hostname) return "error: --url must include a host";
  if (u.username || u.password) return "error: --url must not contain credentials (user:password@)";
  if (u.search || raw.includes("?")) return "error: --url must not contain a query string";
  if (u.hash || raw.includes("#")) return "error: --url must not contain a fragment";
  return null;
}

/** Pure argv parser (argv excludes node and the script). Callers print `error` plus `usage` and exit with code 2. */
export function parseDemoArgs(argv: string[]): DemoArgsResult {
  for (const f of FLAGS) {
    const n = argv.filter((a) => a === `--${f}` || a.startsWith(`--${f}=`)).length;
    if (n > 1) return fail(`error: --${f} was given more than once`);
  }
  let values: { fast?: boolean; speed?: string; json?: string; live?: boolean; url?: string; session?: string; "no-color"?: boolean; help?: boolean };
  try {
    ({ values } = nodeParseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: {
        fast: { type: "boolean" }, speed: { type: "string" }, json: { type: "string" }, live: { type: "boolean" },
        url: { type: "string" }, session: { type: "string" }, "no-color": { type: "boolean" }, help: { type: "boolean" },
      },
    }));
  } catch (err) { return fail(`error: ${(err as Error).message.split("\n")[0]}`); }

  if (values.fast && values.speed !== undefined) return fail("error: --fast and --speed cannot be combined");

  let speed = 1;
  if (values.speed !== undefined) {
    const range = `error: --speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(values.speed)) return fail(range);
    speed = Number(values.speed);
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return fail(range);
  }
  if (values.json !== undefined && (values.json === "" || hasControl(values.json))) return fail("error: --json needs a file path, or - for stdout");
  if (values.url !== undefined) { const bad = checkWsUrl(values.url); if (bad) return fail(bad); }
  if (values.session !== undefined && !isValidSessionId(values.session)) return fail("error: --session must be 1 to 64 letters, digits, '_' or '-'");

  return {
    ok: true,
    opts: {
      fast: values.fast === true, speed, json: values.json, live: values.live === true, url: values.url,
      session: values.session, noColor: values["no-color"] === true, help: values.help === true,
    },
  };
}
