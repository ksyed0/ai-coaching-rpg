import { parseArgs as nodeParseArgs } from "node:util";
import { isValidSessionId } from "../engine/event-log.js";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 20;
export const MAX_LINES = 20;
export const MAX_FALLBACKS = 1000;
export const MAX_WATCHDOG_MINUTES = 180;

export const DEMO_USAGE = [
  "usage: pnpm demo [--fast] [--speed <x>] [--json <path|->] [--live] [--url <ws://host:port>] [--session <id>] [--transcript <path.md>] [--no-color] [--help]",
  "       pnpm demo --showcase [--scenario <dir>] [--max-lines <n>] [--max-fallbacks <n>] [--watchdog <minutes>] [--live] [--fast] [--json <path|->]",
  `  --fast            no pacing delays (instant narration)`,
  `  --speed <x>       scale the pacing, ${MIN_SPEED} to ${MAX_SPEED} (default 1; 2 is twice as fast)`,
  "  --json <path|->   write a machine-readable report to a file, or to stdout with - (narration then goes to stderr;",
  "                    run `pnpm -s demo ...` so pnpm's own banner stays out of stdout)",
  "  --transcript <path.md>  also write a Markdown transcript (dialogue in bold, tagged SCRIPTED / GENERATED / FALLBACK; works in every mode)",
  "  --live            use the real configured model provider (sends text to it, may cost money)",
  "  --url <ws://...>  smoke-test an already running server instead of starting one",
  "  --session <id>    session id (default: demo, or local with --url)",
  "  --no-color        plain output (also: NO_COLOR, or output that is not a terminal)",
  "  --showcase        play the longer scenario so the AI characters and the Game Master do substantial work (works with --live;",
  "                    not with --url). Ends with an 'AI contribution' summary",
  "  --scenario <dir>  the scenario package for --showcase (default scenarios/friday-escalation-extended, relative to the repo root)",
  `  --max-lines <n>   --showcase only: speak at most n scripted player lines per scene, 1 to ${MAX_LINES} (a slow local model: try 2)`,
  `  --max-fallbacks <n> --showcase only: fail the run when more than n AI replies were canned fallback lines, 0 to ${MAX_FALLBACKS}`,
  "                    (without it the count is only a warning)",
  `  --watchdog <min>  real-time limit for the whole run, 1 to ${MAX_WATCHDOG_MINUTES} minutes (--showcase default: 3, or 30 with --live;`,
  "                    the default 29-check run keeps its own 2 / 10 minute limits)",
].join("\n");

export type DemoOptions = {
  fast: boolean; speed: number; json: string | undefined; live: boolean; url: string | undefined;
  session: string | undefined; noColor: boolean; help: boolean;
  /** Showcase options stay undefined unless given, so a default run's options are exactly what they always were. */
  showcase?: true; scenario?: string; maxLines?: number; maxFallbacks?: number; watchdog?: number; transcript?: string;
};
export type DemoArgsResult = { ok: true; opts: DemoOptions } | { ok: false; error: string; usage: string };

const fail = (error: string): DemoArgsResult => ({ ok: false, error, usage: DEMO_USAGE });
const FLAGS = ["fast", "speed", "json", "live", "url", "session", "no-color", "help", "showcase", "scenario", "max-lines", "max-fallbacks", "watchdog", "transcript"];
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
  let values: { fast?: boolean; speed?: string; json?: string; live?: boolean; url?: string; session?: string; "no-color"?: boolean; help?: boolean; showcase?: boolean; scenario?: string; "max-lines"?: string; "max-fallbacks"?: string; watchdog?: string; transcript?: string };
  try {
    ({ values } = nodeParseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: {
        fast: { type: "boolean" }, speed: { type: "string" }, json: { type: "string" }, live: { type: "boolean" },
        url: { type: "string" }, session: { type: "string" }, "no-color": { type: "boolean" }, help: { type: "boolean" },
        showcase: { type: "boolean" }, scenario: { type: "string" }, "max-lines": { type: "string" }, "max-fallbacks": { type: "string" }, watchdog: { type: "string" }, transcript: { type: "string" },
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
  if (values.transcript !== undefined && (values.transcript === "" || hasControl(values.transcript))) return fail("error: --transcript needs a file path");
  if (values.url !== undefined) { const bad = checkWsUrl(values.url); if (bad) return fail(bad); }
  if (values.session !== undefined && !isValidSessionId(values.session)) return fail("error: --session must be 1 to 64 letters, digits, '_' or '-'");

  if (values.showcase && values.url !== undefined) return fail("error: --showcase cannot be combined with --url (the showcase starts its own in-process server)");
  for (const [flag, given] of [["scenario", values.scenario], ["max-lines", values["max-lines"]], ["max-fallbacks", values["max-fallbacks"]]] as const) {
    if (given !== undefined && !values.showcase) return fail(`error: --${flag} needs --showcase`);
  }
  if (values.scenario !== undefined && (values.scenario === "" || hasControl(values.scenario))) return fail("error: --scenario needs a directory path");
  const whole = (raw: string | undefined, min: number, max: number): number | undefined | null => {
    if (raw === undefined) return undefined;
    if (!/^[0-9]+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
  };
  const maxLines = whole(values["max-lines"], 1, MAX_LINES);
  if (maxLines === null) return fail(`error: --max-lines must be a whole number from 1 to ${MAX_LINES}`);
  const maxFallbacks = whole(values["max-fallbacks"], 0, MAX_FALLBACKS);
  if (maxFallbacks === null) return fail(`error: --max-fallbacks must be a whole number from 0 to ${MAX_FALLBACKS}`);
  const watchdog = whole(values.watchdog, 1, MAX_WATCHDOG_MINUTES);
  if (watchdog === null) return fail(`error: --watchdog must be a whole number of minutes from 1 to ${MAX_WATCHDOG_MINUTES}`);

  return {
    ok: true,
    opts: {
      fast: values.fast === true, speed, json: values.json, live: values.live === true, url: values.url,
      session: values.session, noColor: values["no-color"] === true, help: values.help === true,
      showcase: values.showcase === true ? true : undefined, scenario: values.scenario, maxLines, maxFallbacks, watchdog, transcript: values.transcript,
    },
  };
}
