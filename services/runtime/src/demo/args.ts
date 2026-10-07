import { parseArgs as nodeParseArgs } from "node:util";
import { isValidSessionId } from "../engine/event-log.js";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 20;
export const MAX_LINES = 20;
export const MAX_FALLBACKS = 1000;
export const MAX_WATCHDOG_MINUTES = 180;
export const MAX_MIN_GM_EXITS = 99;

export const MAX_MODEL_ID_CHARS = 200;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

export const DEMO_USAGE = [
  "usage: pnpm demo [--fast] [--speed <x>] [--json <path|->] [--live] [--url <ws://host:port>] [--session <id>] [--transcript <path.md>] [--security] [--resume] [--no-color] [--help]",
  "       pnpm demo --showcase [--scenario <dir>] [--max-lines <n>] [--max-fallbacks <n>] [--watchdog <minutes>] [--players scripted|generated] [--player-model <id>] [--no-intents] [--evaluate] [--eval-out <dir>] [--gm-trace <path.jsonl>] [--min-gm-exits <n>] [--max-false-exits <n>] [--live] [--fast] [--json <path|->]",
  `  --fast            no pacing delays (instant narration)`,
  `  --speed <x>       scale the pacing, ${MIN_SPEED} to ${MAX_SPEED} (default 1; 2 is twice as fast)`,
  "  --json <path|->   write a machine-readable report to a file, or to stdout with - (narration then goes to stderr;",
  "                    run `pnpm -s demo ...` so pnpm's own banner stays out of stdout)",
  "  --transcript <path.md>  also write a Markdown transcript (dialogue in bold, tagged SCRIPTED / GENERATED / FALLBACK; works in every mode)",
  "  --live            use the real configured model provider (sends text to it, may cost money)",
  "  --url <ws://...>  smoke-test an already running server instead of starting one; if it sets FACILITATOR_TOKEN,",
  "                    export the same variable (never a command-line value)",
  "  --security        also run the security room (F-31 to F-33): a facilitator token, rate limit, connection caps and Origin check",
  "                    on two extra in-process servers (not with --url or --showcase)",
  "  --resume          also run the resume room (F-34 to F-42): a server killed mid-scene and restarted on its log, what a restart",
  "                    refuses (another scenario, a corrupt log, a log another server holds) and the fresh and ended rotations (not with --url or --showcase)",
  "  --session <id>    session id (default: demo, or local with --url)",
  "  --no-color        plain output (also: NO_COLOR, or output that is not a terminal)",
  "  --showcase        play the longer scenario so the AI characters and the Game Master do substantial work (works with --live;",
  "                    not with --url). Ends with an 'AI contribution' summary",
  "  --scenario <dir>  the scenario package for --showcase (default scenarios/friday-escalation-extended, relative to the repo root)",
  `  --max-lines <n>   --showcase only: speak at most n scripted player lines per scene, 1 to ${MAX_LINES} (a slow local model: try 2)`,
  "  --players <mode>  --showcase only: who speaks the player roles: scripted (default, the lines in showcase.yaml) or generated (the model plays",
  "                    them too, using each scripted line as its private intent; needs --live; a failed generation falls back to the scripted line)",
  "  --player-model <id> --players generated only: the model id for the player bots (default: the NPC model, NPC_MODEL)",
  "  --no-intents      --players generated only: do not log each generated player's private intent (the scripted line it was asked to express)",
  "  --evaluate        --showcase only: after the checks, run the post-session evaluator on this run's log and write the feedback reports (adds check S-16;",
  "                    mock runs use a scripted offline evaluator, --live sends the transcript to the model provider and may cost money)",
  "  --eval-out <dir>  --evaluate only: where the reports go, into <dir>/<session-id>/ (default data/reports, relative to where you ran pnpm)",
  "  --gm-trace <path> --showcase only: write every raw Game Master reply and how it was read to <path> (JSON lines, owner-only file; it holds the",
  "                    conversation's judgements, so keep it private). `pnpm gm-eval --trace <path>` replays it offline",
  `  --min-gm-exits <n> --showcase --live only: fail check S-18 when the Game Master ended fewer than n scenes, 0 to ${MAX_MIN_GM_EXITS} (without it S-18 only reports)`,
  `  --max-false-exits <n> --showcase --live only: S-18 also fails when the Game Master ended more than n scenes without AI characters EARLY (at or before the last scripted line after which the gm-eval labels say the condition is not yet met); explicit only (early exits are always reported), not with --players generated, 0 to ${MAX_MIN_GM_EXITS}`,
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
  /** Only set for `--players generated` (scripted is the default and leaves it undefined). */
  players?: "generated"; playerModel?: string; noIntents?: true;
  /** Only set with `--evaluate` (and `--eval-out`). */
  evaluate?: true; evalOut?: string;
  /** Only set with `--gm-trace <path>` (needs --showcase). */
  gmTrace?: string;
  /** Only set with `--min-gm-exits <n>` (needs --showcase --live). */
  minGmExits?: number;
  /** Only set with `--max-false-exits <n>` (needs --showcase --live). */
  maxFalseExits?: number;
  /** Only set with `--security`: adds the security room checks F-31 to F-33 to the default run. */
  security?: true;
  /** Only set with `--resume`: adds the resume room checks F-34 to F-42 to the default run. */
  resume?: true;
};
export type DemoArgsResult = { ok: true; opts: DemoOptions } | { ok: false; error: string; usage: string };

const fail = (error: string): DemoArgsResult => ({ ok: false, error, usage: DEMO_USAGE });
const FLAGS = ["fast", "speed", "json", "live", "url", "session", "no-color", "help", "showcase", "scenario", "max-lines", "max-fallbacks", "watchdog", "transcript", "players", "player-model", "no-intents", "evaluate", "eval-out", "gm-trace", "min-gm-exits", "max-false-exits", "security", "resume"];
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
  let values: { fast?: boolean; speed?: string; json?: string; live?: boolean; url?: string; session?: string; "no-color"?: boolean; help?: boolean; showcase?: boolean; scenario?: string; "max-lines"?: string; "max-fallbacks"?: string; watchdog?: string; transcript?: string; players?: string; "player-model"?: string; "no-intents"?: boolean; evaluate?: boolean; "eval-out"?: string; "gm-trace"?: string; "min-gm-exits"?: string; "max-false-exits"?: string; security?: boolean; resume?: boolean };
  try {
    ({ values } = nodeParseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: {
        fast: { type: "boolean" }, speed: { type: "string" }, json: { type: "string" }, live: { type: "boolean" },
        url: { type: "string" }, session: { type: "string" }, "no-color": { type: "boolean" }, help: { type: "boolean" },
        showcase: { type: "boolean" }, scenario: { type: "string" }, "max-lines": { type: "string" }, "max-fallbacks": { type: "string" }, watchdog: { type: "string" }, transcript: { type: "string" }, players: { type: "string" }, "player-model": { type: "string" }, "no-intents": { type: "boolean" }, evaluate: { type: "boolean" }, "eval-out": { type: "string" }, "gm-trace": { type: "string" }, "min-gm-exits": { type: "string" }, "max-false-exits": { type: "string" }, security: { type: "boolean" }, resume: { type: "boolean" },
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

  if (values.players !== undefined) {
    if (values.players !== "scripted" && values.players !== "generated") return fail("error: --players must be scripted or generated");
    if (!values.showcase) return fail("error: --players needs --showcase");
    if (values.players === "generated" && !values.live) return fail("error: --players generated needs --live (the mock and CI runs stay scripted)");
  }
  if (values["no-intents"] && values.players !== "generated") return fail("error: --no-intents needs --players generated");
  if (values["player-model"] !== undefined) {
    if (values.players !== "generated") return fail("error: --player-model needs --players generated");
    const id = values["player-model"];
    if (id.length > MAX_MODEL_ID_CHARS || !MODEL_ID.test(id) || id.includes("://")) return fail(`error: --player-model must be a model id of 1 to ${MAX_MODEL_ID_CHARS} letters, digits and . _ : / + - (no spaces, no URL)`);
  }

  if (values.security && values.url !== undefined) return fail("error: --security cannot be combined with --url (the security room starts its own in-process servers)");
  if (values.security && values.showcase) return fail("error: --security belongs to the default run, not --showcase");
  if (values.resume && values.url !== undefined) return fail("error: --resume cannot be combined with --url (the resume room starts its own in-process servers)");
  if (values.resume && values.showcase) return fail("error: --resume belongs to the default run, not --showcase");
  if (values.evaluate && !values.showcase) return fail("error: --evaluate needs --showcase");
  if (values["eval-out"] !== undefined) {
    if (!values.evaluate) return fail("error: --eval-out needs --evaluate");
    if (values["eval-out"] === "" || hasControl(values["eval-out"])) return fail("error: --eval-out needs a directory path");
  }

  if (values["gm-trace"] !== undefined) {
    if (!values.showcase) return fail("error: --gm-trace needs --showcase");
    if (values["gm-trace"] === "" || hasControl(values["gm-trace"])) return fail("error: --gm-trace needs a file path");
  }

  const minGmExits = whole(values["min-gm-exits"], 0, MAX_MIN_GM_EXITS);
  if (minGmExits === null) return fail(`error: --min-gm-exits must be a whole number from 0 to ${MAX_MIN_GM_EXITS}`);
  if (minGmExits !== undefined && !(values.showcase && values.live)) return fail("error: --min-gm-exits needs --showcase and --live (check S-18 only runs against a real model)");

  const maxFalseExits = whole(values["max-false-exits"], 0, MAX_MIN_GM_EXITS);
  if (maxFalseExits === null) return fail(`error: --max-false-exits must be a whole number from 0 to ${MAX_MIN_GM_EXITS}`);
  if (maxFalseExits !== undefined && values.players === "generated") return fail("error: --max-false-exits cannot be combined with --players generated (generated players do not follow the scripted lines the labels refer to)");
  if (maxFalseExits !== undefined && !(values.showcase && values.live)) return fail("error: --max-false-exits needs --showcase and --live (check S-18 only runs against a real model)");

  return {
    ok: true,
    opts: {
      fast: values.fast === true, speed, json: values.json, live: values.live === true, url: values.url,
      session: values.session, noColor: values["no-color"] === true, help: values.help === true,
      showcase: values.showcase === true ? true : undefined, scenario: values.scenario, maxLines, maxFallbacks, watchdog, transcript: values.transcript,
      players: values.players === "generated" ? "generated" : undefined, playerModel: values["player-model"], noIntents: values["no-intents"] === true ? true : undefined,
      evaluate: values.evaluate === true ? true : undefined, evalOut: values["eval-out"], gmTrace: values["gm-trace"], minGmExits, maxFalseExits, ...(values.security === true ? { security: true as const } : {}), ...(values.resume === true ? { resume: true as const } : {}),
    },
  };
}
