import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isSafeId } from "@acr/events";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { secretValues } from "../evaluator/cli.js";
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { readRegularCapped } from "../util/read-regular.js";
import {
  ReviewCorruptError,
  ReviewRefusedError,
  ReviewUsageError,
} from "./errors.js";
import { loadDrafts } from "./draft.js";
import { sha256 } from "./hash.js";
import {
  applyCommand,
  loadReview,
  openReview,
  readCodesRecord,
  supersedeReview,
  type Loaded,
} from "./store.js";
import { cleanBy, cleanText, isDraftFileName, parseLevel } from "./text.js";
import { LIMITS, type Actor, type Entry } from "./types.js";
import { renderSubjectMarkdown, viewReport } from "./view.js";

export const MODERATE_USAGE = [
  "usage: pnpm moderate <subcommand> <reports-dir> [options]",
  "  open <dir> --by <name> [--session-log <file>] [--codes-dir <dir>]   start the review of a draft directory written by `pnpm evaluate`",
  "  status <dir>                                                          what is open, per subject",
  "  show <dir> <subject>                                                  the facilitator's view of one report (Markdown to stdout)",
  "  edit <dir> <subject> <criterion> --level 1|2|3|4|na --reason <text> --by <name> [--rationale <text>] [--expect <level>]",
  "  accept <dir> <subject> <criterion> --by <name>   |   accept <dir> <subject> --summary --by <name>",
  "  comment <dir> <subject> --text <text> --by <name> [--criterion <id>] [--feedback]",
  "  edit-summary <dir> <subject> --reason <text> --by <name> [--strength <t>]... [--development <t>]... [--action <lo>:<t>]...",
  "  supersede <old-dir> <new-dir> --by <name>                            move moderation of unchanged subjects to a re-run of a released session; the old review becomes read-only",
  "exit codes: 0 done, 1 refused (fix and retry), 2 usage error or a damaged review/draft file",
  "A subject is a player role or `group`. Free text is stored after hidden characters are stripped and secrets scrubbed.",
].join("\n");

export type Out = { write(chunk: string): unknown };
export type ModerateDeps = {
  argv: string[];
  stdout: Out;
  stderr: Out;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
};
export type Ctx = {
  dir: string;
  base: string;
  now: () => number;
  secrets: string[];
  out: (m: string) => void;
  raw: (m: string) => void;
  values: Record<string, string | boolean | string[] | undefined>;
  args: string[];
};
export type Handler = (c: Ctx) => Promise<number>;

const OPTIONS = {
  by: { type: "string" },
  reason: { type: "string" },
  level: { type: "string" },
  rationale: { type: "string" },
  expect: { type: "string" },
  text: { type: "string" },
  criterion: { type: "string" },
  feedback: { type: "boolean" },
  summary: { type: "boolean" },
  strength: { type: "string", multiple: true },
  development: { type: "string", multiple: true },
  action: { type: "string", multiple: true },
  "session-log": { type: "string" },
  "codes-dir": { type: "string" },
  help: { type: "boolean" },
} as const;

export const ALLOWED: Record<string, string[]> = {
  open: ["by", "session-log", "codes-dir"],
  status: [],
  show: [],
  edit: ["by", "reason", "level", "rationale", "expect"],
  accept: ["by", "summary"],
  comment: ["by", "text", "criterion", "feedback"],
  "edit-summary": ["by", "reason", "strength", "development", "action"],
  supersede: ["by"],
};

/** Most positional arguments after <dir> each subcommand takes. */
const ARITY: Record<string, number> = {
  open: 0,
  status: 0,
  show: 1,
  edit: 2,
  accept: 2,
  comment: 1,
  "edit-summary": 1,
  supersede: 1,
};
const facilitator = (c: Ctx): Actor => ({
  kind: "facilitator",
  by: cleanBy(c.values.by),
});
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new ReviewRefusedError(`unknown ${what}`);
  return v;
};
/** A file name from the directory, safe to print: hidden characters stripped, markup and secrets scrubbed, at most 64 characters. */
const shownName = (n: string): string => {
  const t = Array.from(scrubText(stripHidden(n), []))
    .slice(0, 64)
    .join("");
  return `\`${t}${Array.from(n).length > 64 ? "..." : ""}\``;
};
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** One line of rendered Markdown made safe for a terminal; the line's own layout (tables, tabs) is kept. */
function cleanLine(line: string, secrets: string[]): string {
  let out = stripHidden(line).replace(CONTROLS, "");
  for (const x of secrets) if (x) out = out.split(x).join("[redacted]");
  for (const [dir, label] of [
    [os.tmpdir(), "<tmp>"],
    [os.homedir(), "~"],
  ] as const)
    if (dir && dir !== "/") out = out.split(dir).join(label);
  return out;
}
const lvl = (l: unknown): string => (l === null ? "na" : String(l));

function statusLines(l: Loaded): string[] {
  const out: string[] = [];
  if (l.view.superseded)
    out.push(
      `This review is superseded by ${l.view.superseded} and is read-only.`,
    );
  for (const sv of l.view.subjects.values()) {
    const open = sv.criteria.filter((c) => c.status === "needs_review");
    out.push(
      `${sv.id}: ${sv.state}${sv.versions.length ? ` (version ${sv.versions.at(-1)})` : ""}, ${open.length} of ${sv.criteria.length} criteria need review${sv.summaryStale ? ", summary may be out of date" : ""}${sv.evaluationOk ? "" : ", evaluation failed (score by hand)"}`,
    );
    for (const c of open)
      out.push(`  needs review: ${c.id} (currently ${lvl(c.current)})`);
  }
  return out;
}

export const HANDLERS: Record<string, Handler> = {
  async open(c) {
    const by = cleanBy(c.values.by);
    let sessionLogText: string | undefined;
    const logArg = c.values["session-log"];
    if (typeof logArg === "string") {
      try {
        sessionLogText = await readRegularCapped(
          path.resolve(c.base, logArg),
          64 * 1024 * 1024,
        );
      } catch {
        throw new ReviewUsageError("--session-log cannot be read");
      }
    }
    const d = await loadDrafts(c.dir);
    // openReview would refuse a stray file with an unnamed message; name it (sanitised, bounded) so the facilitator can act.
    for (const name of Object.keys(d.files)) {
      if (!isDraftFileName(name))
        throw new ReviewRefusedError(
          `${shownName(name)} is not a generated report file; move it out of the reports directory and run open again`,
        );
    }
    const codesDir =
      typeof c.values["codes-dir"] === "string"
        ? path.resolve(c.base, c.values["codes-dir"])
        : path.resolve(c.base, "data/sessions");
    const codes = await readCodesRecord(codesDir, d.sessionId);
    const l = await openReview(c.dir, {
      by,
      now: c.now,
      ...(sessionLogText !== undefined ? { sessionLogText } : {}),
      codes,
    });
    c.out(
      `review opened for session ${l.view.opened.session.id}: ${l.view.subjects.size} subjects${l.view.opened.legacy ? " (legacy drafts: no structured flag codes)" : ""}. Next: pnpm moderate status <dir>`,
    );
    return 0;
  },
  async status(c) {
    for (const line of statusLines(await loadReview(c.dir))) c.out(line);
    return 0;
  },
  async show(c) {
    const l = await loadReview(c.dir);
    const id = c.args[0];
    const sv = id ? l.view.subjects.get(id) : undefined;
    if (!id || !sv)
      throw new ReviewRefusedError("unknown subject; run status to list them");
    const draft = l.drafts.subjects.get(id)!.raw as unknown as
      ParticipantReport | GroupReport;
    // Multi-line Markdown: not passed through c.out (scrubText would flatten every line break). Per line: control and
    // hidden characters out (keeps \n and tab), then secrets and machine paths redacted, as scrubText does.
    c.raw(
      renderSubjectMarkdown(
        viewReport(draft, l.view, id, { audience: "facilitator" }),
        c.secrets,
      )
        .split("\n")
        .map((line) => cleanLine(line, c.secrets))
        .join("\n")
        .trimEnd(),
    );
    return 0;
  },
  async edit(c) {
    const [subject, criterion] = c.args;
    if (!subject || !criterion)
      throw new ReviewUsageError("edit needs <subject> <criterion>");
    const actor = facilitator(c);
    const to = parseLevel(c.values.level);
    const reason = cleanText(
      String(c.values.reason ?? ""),
      LIMITS.reason,
      "--reason",
      c.secrets,
    );
    const rationale =
      typeof c.values.rationale === "string"
        ? cleanText(c.values.rationale, LIMITS.text, "--rationale", c.secrets)
        : undefined;
    const expect =
      typeof c.values.expect === "string" ? c.values.expect : undefined;
    if (
      expect !== undefined &&
      !["1", "2", "3", "4", "na", "invalid"].includes(expect)
    )
      throw new ReviewUsageError("--expect needs 1, 2, 3, 4, na or invalid");
    await applyCommand(c.dir, c.now, (l) => {
      const sv = need(l.view.subjects.get(subject), "subject");
      const cv = need(
        sv.criteria.find((x) => x.id === criterion),
        "criterion",
      );
      if (
        expect !== undefined &&
        expect !== (cv.current === "invalid" ? "invalid" : lvl(cv.current))
      )
        throw new ReviewRefusedError(
          `${criterion} is currently ${cv.current === "invalid" ? "invalid" : lvl(cv.current)}, not ${expect}; nothing was changed`,
        );
      const entries: Entry[] = [
        {
          actor,
          body: {
            type: "score.edited",
            subject,
            criterion,
            from: cv.current,
            to,
            reason,
          },
        },
      ];
      if (rationale !== undefined)
        entries.push({
          actor,
          body: {
            type: "rationale.edited",
            subject,
            criterion,
            fromHash: sha256(cv.rationale),
            text: rationale,
            reason,
          },
        });
      return entries;
    });
    c.out(`${subject} ${criterion} set to ${lvl(to)}`);
    return 0;
  },
  async accept(c) {
    const [subject, criterion] = c.args;
    if (!subject)
      throw new ReviewUsageError(
        "accept needs <subject> and a <criterion> or --summary",
      );
    const actor = facilitator(c);
    if (c.values.summary === true && criterion)
      throw new ReviewUsageError(
        "accept takes a <criterion> or --summary, not both",
      );
    if (c.values.summary === true) {
      await applyCommand(c.dir, c.now, () => [
        { actor, body: { type: "summary.accepted", subject } },
      ]);
      c.out(`${subject} summary accepted`);
      return 0;
    }
    if (!criterion)
      throw new ReviewUsageError("accept needs a <criterion> or --summary");
    await applyCommand(c.dir, c.now, () => [
      { actor, body: { type: "score.accepted", subject, criterion } },
    ]);
    c.out(`${subject} ${criterion} accepted`);
    return 0;
  },
  async comment(c) {
    const [subject] = c.args;
    if (!subject) throw new ReviewUsageError("comment needs <subject>");
    const actor = facilitator(c);
    const text = cleanText(
      String(c.values.text ?? ""),
      LIMITS.text,
      "--text",
      c.secrets,
    );
    const criterion =
      typeof c.values.criterion === "string" ? c.values.criterion : undefined;
    await applyCommand(c.dir, c.now, () => [
      {
        actor,
        body: {
          type: "comment.added",
          subject,
          ...(criterion !== undefined ? { criterion } : {}),
          text,
          visibility: c.values.feedback === true ? "feedback" : "internal",
        },
      },
    ]);
    c.out(`comment added to ${subject}`);
    return 0;
  },
  async "edit-summary"(c) {
    const [subject] = c.args;
    if (!subject) throw new ReviewUsageError("edit-summary needs <subject>");
    const actor = facilitator(c);
    const reason = cleanText(
      String(c.values.reason ?? ""),
      LIMITS.reason,
      "--reason",
      c.secrets,
    );
    const items = (v: unknown, what: string): string[] =>
      (Array.isArray(v) ? v : []).map((t) =>
        cleanText(String(t), LIMITS.item, what, c.secrets),
      );
    const summary = {
      strengths: items(c.values.strength, "--strength"),
      development_points: items(c.values.development, "--development"),
      next_actions: items(c.values.action, "--action").map((a) => {
        const i = a.indexOf(":");
        if (i < 1) throw new ReviewUsageError("--action needs <lo>:<text>");
        return { lo: a.slice(0, i), action: a.slice(i + 1).trim() };
      }),
    };
    if (
      !summary.strengths.length &&
      !summary.development_points.length &&
      !summary.next_actions.length
    )
      throw new ReviewUsageError(
        "edit-summary needs at least one --strength, --development or --action; it replaces the whole summary",
      );
    await applyCommand(c.dir, c.now, (l) => {
      const known = l.drafts.subjects.get(subject)?.objectives ?? [];
      for (const a of summary.next_actions)
        if (
          !isSafeId(a.lo) ||
          (known.length && !known.some((o) => o.id === a.lo))
        )
          throw new ReviewUsageError(
            "--action needs the id of one of the report's learning objectives before the colon",
          );
      return [
        { actor, body: { type: "summary.edited", subject, summary, reason } },
      ];
    });
    c.out(`${subject} summary replaced`);
    return 0;
  },
};

HANDLERS.supersede = async (c) => {
  const newArg = c.args[0];
  if (!newArg)
    throw new ReviewUsageError("supersede needs <old-dir> <new-dir>");
  const newDir = path.resolve(c.base, newArg);
  if (!(await stat(newDir).catch(() => null))?.isDirectory())
    throw new ReviewUsageError("the new reports directory does not exist");
  const r = await supersedeReview(c.dir, newDir, {
    by: cleanBy(c.values.by),
    now: c.now,
  });
  c.out(
    `carried forward: ${r.carried.join(", ") || "none"}; starts clean: ${r.fresh.join(", ") || "none"}`,
  );
  return 0;
};

export async function runModerate(
  deps: ModerateDeps,
): Promise<{ exitCode: number }> {
  const secrets = secretValues(deps.env);
  // scrub first, then cut by code points: a cut can never split a redaction or a surrogate pair
  const err = (m: string) =>
    deps.stderr.write(
      `${Array.from(scrubText(m, secrets)).slice(0, 400).join("")}\n`,
    );
  const usage = (m: string) => {
    err(m);
    deps.stderr.write(`${MODERATE_USAGE}\n`);
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: deps.argv,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: OPTIONS,
    });
    const seen = new Set<string>();
    for (const t of parsed.tokens ?? []) {
      if (t.kind !== "option") continue;
      const o = OPTIONS[t.name as keyof typeof OPTIONS] as {
        multiple?: boolean;
      };
      if (!o.multiple && seen.has(t.name))
        throw new Error(`--${t.name} was given more than once`);
      seen.add(t.name);
    }
  } catch (e) {
    usage(`error: ${(e as Error).message.split("\n")[0]}`);
    return { exitCode: 2 };
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout.write(`${MODERATE_USAGE}\n`);
    return { exitCode: 0 };
  }
  const [sub, dirArg, ...args] = positionals;
  const handler = sub ? HANDLERS[sub] : undefined;
  if (!sub || !handler || !dirArg) {
    usage("error: give a subcommand and a reports directory");
    return { exitCode: 2 };
  }
  const given = Object.keys(values).filter(
    (k) => values[k as keyof typeof values] !== undefined,
  );
  const bad = given.find((k) => !ALLOWED[sub]!.includes(k));
  if (bad) {
    usage(`error: --${bad} is not an option of ${sub}`);
    return { exitCode: 2 };
  }
  if (args.length > ARITY[sub]!) {
    usage(`error: too many arguments for ${sub}`);
    return { exitCode: 2 };
  }
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
  const dir = path.resolve(base, dirArg);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    err("error: the reports directory does not exist");
    return { exitCode: 2 };
  }
  const ctx: Ctx = {
    dir,
    base,
    now: deps.now ?? Date.now,
    secrets,
    out: (m) => deps.stdout.write(`${scrubText(m, secrets)}\n`),
    raw: (m) => deps.stdout.write(`${m}\n`),
    values: values as Ctx["values"],
    args,
  };
  try {
    return { exitCode: await handler(ctx) };
  } catch (e) {
    if (e instanceof ReviewRefusedError) {
      err(`refused: ${e.message}`);
      return { exitCode: 1 };
    }
    if (e instanceof ReviewUsageError || e instanceof ReviewCorruptError) {
      err(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    err("error: the command failed");
    return { exitCode: 2 };
  }
}
