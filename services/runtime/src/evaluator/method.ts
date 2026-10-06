import { LEVEL_LABELS } from "@acr/script";
import { LO_THRESHOLDS } from "./aggregate.js";

/** Printed in every report and stored in every JSON file: how the scores were produced and what they can and cannot tell you. */
export const METHOD_VERSION = "bars-1";

export const VISIBILITY_LINE = "Visibility: all participants (prototype setting; per-participant isolation is planned)";
export const DRAFT_BANNER = "DRAFT: AI-drafted - held for facilitator review before release (facilitator editing is planned)";

export type MethodSection = { title: string; body: string[] };
export type Method = {
  version: string;
  name: string;
  scale: { level: number; label: string; meaning: string }[];
  not_observed: string;
  sections: MethodSection[];
};

const MEANINGS: Record<number, string> = {
  1: "The behaviour was not seen, or the behaviour seen works against the aim.",
  2: "Parts of the behaviour were seen, but it was partial, unplanned or inconsistent.",
  3: "The behaviour was seen clearly and did its job.",
  4: "The behaviour was seen at a high standard: deliberate, adapted to the moment and it moved the conversation forward.",
};

export function buildMethod(): Method {
  return {
    version: METHOD_VERSION,
    name: "Behaviourally Anchored Rating Scale (BARS)",
    scale: ([1, 2, 3, 4] as const).map((level) => ({ level, label: LEVEL_LABELS[level], meaning: MEANINGS[level]! })),
    not_observed: "Not observed (N/O): there is no evidence either way. N/O carries no score and is left out of every average; it is not a low score.",
    sections: [
      {
        title: "What a Behaviourally Anchored Rating Scale is",
        body: [
          "A BARS is a rating scale where each level of each criterion is described by a written example of observable behaviour (the anchor), so a score says what was seen rather than an impression.",
          "This scale has four levels and no midpoint, to avoid the central-tendency habit of rating everything as average. Every criterion in the rubric has its own anchor for each level; the rubric files are the source of those anchors.",
        ],
      },
      {
        title: "The evidence rule",
        body: [
          "Every score must rest on at least one verbatim quote from that participant, with its time in the session. The quote is checked by the program, not by the AI: it must be an exact piece (ignoring spacing) of something that participant said at that moment. A quote that cannot be found is dropped.",
          "A score of 3 or 4 that has no verified quote is capped at 2 and flagged. A score of 1 or 2 with no verified quote is kept, flagged and shown with Low confidence.",
          "Only the participant's own words count as evidence for that participant: what other people said to them, and what they were told in an inject, is context only (first-person-only rule). Group criteria may use quotes from any team member.",
        ],
      },
      {
        title: "Confidence",
        body: [
          "Confidence is High, Medium or Low. It comes from the number of verified quotes (3 or more can support High, 2 Medium, fewer Low) and from the confidence the AI stated; the lower of the two is shown. A capped score is always Low.",
        ],
      },
      {
        title: "How scores are combined",
        body: [
          `A learning-objective score is the mean of the scores of the criteria mapped to it that were observed, rounded to one decimal. Its label is: below ${LO_THRESHOLDS.developing} Not yet demonstrated, below ${LO_THRESHOLDS.proficient} Developing, below ${LO_THRESHOLDS.advanced} Proficient, otherwise Advanced (the rounded number is labelled).`,
          "There is no single overall grade: the overall picture is the list of learning-objective results. A learning objective with no observed criterion is Not observed.",
        ],
      },
      {
        title: "Limitations",
        body: [
          "This is an AI-drafted assessment and needs facilitator review before it is released or acted on. The AI can misread tone, humour, irony or context, and can be wrong.",
          "The sample is small: three players in one session. One session is a snapshot of one conversation in one scenario, not a measure of a person's general ability.",
          "Only what was said is assessed. Work done off the call, non-verbal behaviour and what was thought but not said are not seen. Talk time is context, not a criterion.",
          "Evidence is limited to a person's own words (first-person-only rule); a good idea that someone else voiced is not credited to a teammate.",
          "Long sessions may be trimmed before being sent to the AI; the report says when that happened.",
        ],
      },
    ],
  };
}

/** The method section as Markdown lines (static text; nothing in it comes from a model or a participant). */
export function methodMarkdown(headingLevel = 2): string[] {
  const m = buildMethod();
  const h = "#".repeat(headingLevel);
  const out: string[] = [`${h} How this was scored`, "", `Method: ${m.name} (${m.version}).`, "", "| Level | Label | Meaning |", "| --- | --- | --- |"];
  for (const s of m.scale) out.push(`| ${s.level} | ${s.label} | ${s.meaning} |`);
  out.push("", m.not_observed, "");
  for (const sec of m.sections) {
    out.push(`${h}# ${sec.title}`, "");
    for (const p of sec.body) out.push(p, "");
  }
  return out;
}
