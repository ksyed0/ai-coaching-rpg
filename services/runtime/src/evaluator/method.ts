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
  1: "There was a clear opportunity to show the behaviour and it was absent from the participant's own words, or the participant worked against the aim.",
  2: "Parts of the behaviour were seen, but it was partial, unplanned or inconsistent.",
  3: "The behaviour was seen clearly and did its job.",
  4: "The behaviour was seen at a high standard: deliberate, adapted to the moment and it moved the conversation forward.",
};

/** Who is described: `players` is the number of player roles in the scenario (the limitations text uses it). */
export function buildMethod(o: { players?: number } = {}): Method {
  const n = o.players ?? 3;
  const sample = n === 1 ? "one player" : `${n} players`;
  return {
    version: METHOD_VERSION,
    name: "Behaviourally Anchored Rating Scale (BARS)",
    scale: ([1, 2, 3, 4] as const).map((level) => ({ level, label: LEVEL_LABELS[level], meaning: MEANINGS[level]! })),
    not_observed: "Not observed (N/O): the participant had no opportunity to show the behaviour, or there is no usable evidence either way. N/O carries no score and is left out of every average; it is not a low score. Invalid (evaluator error) is different: the AI's answer for that criterion was unusable even after one retry, so the criterion is left out of the averages and the learning objective is marked incomplete.",
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
          "Every score of 3 or 4 must rest on at least one verified quote. A score of 1 or 2 may stand without one: it is then flagged and shown with Low confidence.",
          "A quote is checked by the program, not by the AI: after spacing is normalised, and after quote marks, ellipses at the edges and invisible characters are removed, it must be an exact, case-sensitive piece of one thing that participant said, at the line number the AI named. It must be at least 8 characters long; a quote that keeps a 3 or 4 must have at least 15 characters and 3 words. A quote that cannot be found is dropped, and so is a quote that lies inside or overlaps another quote from the same line.",
          "A 3 or 4 with no such quote is capped at 2 and flagged. Shorter verified quotes stay as evidence for a 1 or 2 and are flagged.",
          "Only the participant's own words count as evidence for that participant: what other people said to them, and what they were told in an inject, is context only (first-person-only rule). Group criteria may use quotes from any player.",
          "Verification proves that the words exist in the participant's own line, not that they show the behaviour, and a participant can write rating language into their own line. A quote that contains rating language is flagged for the reviewer. Facilitator review is required.",
        ],
      },
      {
        title: "Confidence",
        body: [
          "Confidence is High, Medium or Low. It comes from the number of DISTINCT lines with a verified quote (3 or more distinct lines can support High, 2 Medium, fewer Low) and from the confidence the AI stated; the lower of the two is shown. If the AI states no usable confidence it counts as Medium, so the AI can lower a confidence but never raise it above the evidence. A capped score is always Low.",
        ],
      },
      {
        title: "How scores are combined",
        body: [
          `A learning-objective score is the mean of the scores of the criteria mapped to it that were observed, rounded to one decimal. Its label is: below ${LO_THRESHOLDS.developing} Not yet demonstrated, below ${LO_THRESHOLDS.proficient} Developing, below ${LO_THRESHOLDS.advanced} Proficient, otherwise Advanced (the rounded number is labelled).`,
          "There is no single overall grade: the overall picture is the list of learning-objective results. A learning objective with no observed criterion is Not observed; one with an invalid criterion is marked incomplete.",
          "Roles that had little opportunity for a criterion (for example a tech lead on commercial negotiation) will show Not observed for it. That is expected and is not a weakness.",
        ],
      },
      {
        title: "Limitations",
        body: [
          "This is an AI-drafted assessment and needs facilitator review before it is released or acted on. The AI can misread tone, humour, irony or context, and can be wrong.",
          `The sample is small: ${sample} in one session. One session is a snapshot of one conversation in one scenario, not a measure of a person's general ability.`,
          "Only what was said is assessed. Work done off the call, non-verbal behaviour and what was thought but not said are not seen. Talk time is context, not a criterion.",
          "Evidence is limited to a person's own words (first-person-only rule); a good idea that someone else voiced is not credited to a teammate.",
          "Long sessions may be trimmed before being sent to the AI; the report says when that happened.",
        ],
      },
    ],
  };
}

/** The method section as Markdown lines (static text; nothing in it comes from a model or a participant). */
export function methodMarkdown(m: Method = buildMethod(), headingLevel = 2): string[] {
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
