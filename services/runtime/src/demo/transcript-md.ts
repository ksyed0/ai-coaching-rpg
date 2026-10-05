import { TAGS } from "./provenance.js";
import { scrubText, type CheckResult } from "./report.js";
import type { ShowcaseReport } from "./showcase-report.js";
import type { TLine } from "./transcript.js";

/** Escapes every Markdown and HTML metacharacter, and breaks anything an auto-linker would turn into a link. */
export function mdEscape(text: string): string {
  return text
    .replace(/[\\*_`[\]<>|~!#&]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, ":&#8203;//")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}&#8203;.`)
    .replace(/@/g, "@&#8203;");
}

const DIALOGUE_CHARS = 1_500;
const REASONING_CHARS = 400;
const CELL_CHARS = 300;

/** The one safe path for any text that goes into the file: scrub secrets and paths, sanitize, truncate, then escape Markdown. */
export function safeMd(text: string, max: number, secrets: string[] = []): string {
  const clean = scrubText(String(text ?? ""), secrets);
  return mdEscape(clean.length > max ? `${clean.slice(0, max - 1)}…` : clean);
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
    `${TAGS.scripted} text authored in advance: bot player lines, facilitator whispers and every reply of the scripted mock providers.`, "",
    `${TAGS.generated} produced by a live model at run time: live AI character replies and the Game Master's reasoning.`, "",
    `${TAGS.fallback} the character's canned fallback line, used in place of a missing model reply (scripted text, never generated).`, "",
    `${TAGS.system} technical logging, not dialogue.`, "",
    "Dialogue lines are **bold**. Text is escaped, so nothing in a line can forge a tag, a heading, a table or a link.", "");

  for (const r of i.records) {
    if (r.kind === "heading") out.push(`## ${safeMd(r.text, 200, sec)}`, "");
    else if (r.kind === "log") out.push(`${TAGS.system} ${safeMd(r.text, DIALOGUE_CHARS, sec)}`, "");
    else if (r.gm) {
      out.push(`**${TAGS[r.source === "system" ? "scripted" : r.source]} Game Master (verdict: ${r.gm.verdict ? "true" : "false"}) on "${safeMd(r.gm.condition, 200, sec)}": ${safeMd(r.text, REASONING_CHARS, sec)}**`, "");
    } else {
      out.push(`**${TAGS[r.source === "system" ? "scripted" : r.source]} ${who(r.speaker ?? "?", r.role, sec)}: ${safeMd(r.text, DIALOGUE_CHARS, sec)}**`, "");
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
  }

  out.push("## Checks", "", "| Id | Status | Check | Evidence |", "| --- | --- | --- | --- |");
  for (const r of i.results) out.push(`| ${cell(r.id)} | ${r.status} | ${cell(r.title)} | ${cell(r.details)} |`);
  out.push("");
  return out.join("\n");
}
