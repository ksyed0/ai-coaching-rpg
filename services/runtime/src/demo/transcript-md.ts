import { TAGS } from "./provenance.js";
import { scrubText, type CheckResult } from "./report.js";
import type { ShowcaseReport } from "./showcase-report.js";
import type { TLine } from "./transcript.js";

/** Escapes every Markdown and HTML metacharacter, and breaks anything an auto-linker would turn into a link. */
export function mdEscape(text: string): string {
  return text
    .replace(/[\\*_`[\]<>|~!#&$]/g, (c) => `\\${c}`)
    // GitHub autolinks: #123 and owner/repo#1 (break after the #), GH-123, and 7 to 40 hex digit SHAs (break every 6 characters).
    .replace(/\\#(?=\d)/g, "\\#&#8203;")
    .replace(/\bGH-(?=\d)/gi, (m) => `${m}&#8203;`)
    .replace(/[0-9a-f]{7,}/gi, (m) => (m.match(/.{1,6}/g) as string[]).join("&#8203;"))
    .replace(/:\/\//g, ":&#8203;//")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}&#8203;.`)
    .replace(/@/g, "@&#8203;");
}

/** Unicode format characters (Cf), default-ignorable fillers and variation selectors. */
const INVISIBLE_MD = /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f]/gu;
const DIALOGUE_CHARS = 1_500;
const REASONING_CHARS = 400;
const CELL_CHARS = 300;

/** Scrub, sanitize, strip invisible characters, fold look-alikes and neutralize tag-shaped tokens; not yet truncated or escaped. */
function cleanMd(text: string, secrets: string[]): string {
  // Sanitizing turns newlines into a visible marker; trim those and whitespace at both ends so a bold span always closes.
  const scrubbed = scrubText(String(text ?? ""), secrets);
  // Invisible characters (every Unicode format character, default-ignorable fillers, variation selectors, tag characters) could hide
  // inside a tag-shaped token; remove them, then fold look-alikes (fullwidth letters and brackets) with NFKC.
  const folded = scrubbed.replace(INVISIBLE_MD, "").normalize("NFKC");
  const clean = folded.replace(/^(?:\s|⏎)+|(?:\s|⏎)+$/gu, "");
  // A tag-shaped token inside dialogue must never read as a tag: [SCRIPTED] becomes (SCRIPTED).
  return clean.replace(/[[［【〔〖]\s*(SCRIPTED|GENERATED|FALLBACK|UNVERIFIED|SYSTEM)\s*[\]］】〕〗]/gi, "($1)");
}
const truncate = (points: string[], max: number): string => (points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join(""));

/** The one safe path for any text that goes into the file: scrub secrets and paths, sanitize, truncate, then escape Markdown. */
export function safeMd(text: string, max: number, secrets: string[] = []): string {
  return mdEscape(truncate(Array.from(cleanMd(text, secrets)), max)); // truncate by code points: never inside a surrogate pair
}

const MD_NEWLINE = new RegExp(`\\r\\n|[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

/**
 * Like safeMd for a multi-line value: the raw text is split at its newlines BEFORE sanitizing (so no marker is inserted for them),
 * every non-blank line gets the full safeMd treatment, and the total is truncated by code points. Returns the escaped lines.
 */
export function safeMdLines(text: string, max: number, secrets: string[] = []): string[] {
  const out: string[] = [];
  let left = max;
  // Lazy: lines are cleaned one at a time and the scan stops as soon as the budget is used up, so a huge reply is not cleaned in full.
  let start = 0;
  const raw = String(text ?? "");
  const re = new RegExp(MD_NEWLINE.source, "g");
  while (start <= raw.length && left > 0) {
    re.lastIndex = start;
    const m = re.exec(raw);
    const end = m ? m.index : raw.length;
    const points = Array.from(cleanMd(raw.slice(start, end), secrets));
    start = m ? end + m[0].length : raw.length + 1;
    if (points.length === 0) continue;
    if (points.length >= left) {
      // This line reaches the limit: it is cut here and nothing after it is shown.
      out.push(mdEscape(points.length > left ? `${points.slice(0, Math.max(left - 1, 0)).join("")}…` : points.join("")));
      break;
    }
    out.push(mdEscape(points.join("")));
    left -= points.length;
  }
  return out;
}
const ID = /^[a-z0-9_-]+$/;
const who = (speaker: string, role: string | undefined, secrets: string[]): string => {
  const name = ID.test(speaker) ? speaker : safeMd(speaker, 80, secrets);
  return role && role !== speaker && ID.test(role) ? `${name} (${role})` : name;
};

export type TranscriptInput = {
  title: string;
  meta: { mode: string; provider: string; scenario: string; date: string; version: string; summary: string };
  records: TLine[];
  results: CheckResult[];
  showcase?: ShowcaseReport;
  secrets?: string[];
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Renders the transcript. Pure. Dialogue is bold in full and carries its provenance tag; technical logging is plain `[SYSTEM]` lines. */
export function renderTranscript(i: TranscriptInput): string {
  const sec = i.secrets ?? [];
  const cell = (t: string) => safeMd(t, CELL_CHARS, sec);
  const out: string[] = [`# ${safeMd(i.title, 200, sec)}`, ""];
  out.push("| Field | Value |", "| --- | --- |");
  for (const [k, v] of [["Mode", i.meta.mode], ["Provider", i.meta.provider], ["Scenario", i.meta.scenario], ["Date", i.meta.date], ["Tool version", i.meta.version], ["Summary", i.meta.summary]] as const) {
    out.push(`| ${k} | ${cell(v)} |`);
  }
  out.push("", "## Legend", "",
    `${TAGS.scripted} text authored in advance: bot player lines (also a generated player line that fell back to its scripted text), facilitator whispers and every reply of the scripted mock providers.`, "",
    `${TAGS.generated} produced by a live model at run time: live AI character replies, the Game Master's reasoning and, with \`--players generated\`, the player bots' lines (only when the model wrote the recorded text).`, "",
    `${TAGS.fallback} the character's canned fallback line, used in place of a missing model reply (scripted text, never generated).`, "",
    `${TAGS.unverified} an AI character or Game Master line seen through \`--url\`: the runner cannot tell whether the remote server used a real model or a script. Under \`--url\` the fallback marker is asserted by the remote server: a hostile server can set it, but it can never make a line generated.`, "",
    `${TAGS.system} technical logging, not dialogue.`, "",
    "Dialogue lines are **bold**. Text is escaped, so nothing in a line can forge a tag, a heading, a table or a link.", "");

  for (const r of i.records) {
    if (r.kind === "heading") out.push(`## ${safeMd(r.text, 200, sec)}`, "");
    else if (r.kind === "log") out.push(`${TAGS.system} ${safeMd(r.text, DIALOGUE_CHARS, sec)}`, "");
    else if (r.gm) {
      out.push(`**${TAGS[r.source]} Game Master (verdict: ${r.gm.verdict ? "true" : "false"}) on "${safeMd(r.gm.condition, 200, sec)}": ${safeMd(r.text, REASONING_CHARS, sec)}**`, "");
    } else {
      // Each line is its own bold span inside the one tagged entry, joined by a Markdown hard break (two spaces) so viewers show separate lines.
      const body = safeMdLines(r.text, DIALOGUE_CHARS, sec);
      out.push(`**${TAGS[r.source]} ${who(r.speaker ?? "?", r.role, sec)}: ${body[0] ?? ""}**${body.slice(1).map((l) => `  \n**${l}**`).join("")}`, "");
    }
  }

  if (i.showcase) {
    const s = i.showcase;
    out.push("## AI contribution", "", "| AI character | Replies | Model or scripted output | Fallback lines | Latency (median / max) |", "| --- | --- | --- | --- | --- |");
    for (const n of s.npcs) {
      const latency = n.latencyMs ? `${seconds(n.latencyMs.median)} / ${seconds(n.latencyMs.max)}` : "n/a";
      out.push(`| ${cell(n.name)} (${n.roleId}) | ${n.replies} | ${n.modelReplies} | ${n.fallbackReplies} | ${latency} |`);
    }
    out.push("", "| Game Master | Evaluations | True | False | Scenes it ended |", "| --- | --- | --- | --- | --- |");
    out.push(`| Game Master | ${s.gm.evaluations} evaluations | ${s.gm.verdictsTrue} true | ${s.gm.verdictsFalse} false | exited: ${cell(s.gm.exitedScenes.join(", ") || "none")} |`);
    out.push("", `Facilitator advances: ${s.facilitatorAdvances}. Alerts: ${s.alerts.length}. Canned fallback lines: ${s.fallbackLines}.`, "");
    if (s.players) {
      const p = s.players;
      out.push(`Player bots (generated): ${p.generated} of ${s.playerLines} lines written by the model, ${p.scriptedFallbacks} spoken as the scripted line after a failed generation, ${p.verbatimRepeats} generated line(s) identical to the scripted line.`, "");
    }
  }

  out.push("## Checks", "", "| Id | Status | Check | Evidence |", "| --- | --- | --- | --- |");
  for (const r of i.results) out.push(`| ${cell(r.id)} | ${r.status} | ${cell(r.title)} | ${cell(r.details)} |`);
  out.push("");
  return out.join("\n");
}
