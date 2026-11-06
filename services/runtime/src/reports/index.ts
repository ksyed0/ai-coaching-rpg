/**
 * Read-only access to a session's released reports, for the control service (EPIC-0002, slice 2c-1).
 *
 * It produces what `moderate export --for participant:<role>` writes, but never writes: no review.lock, no applyCommand, no audit
 * event (a deliberate difference from `export`). The reports folder is treated as untrusted input: the session id is validated,
 * symbolic links are never followed, no role or id builds a path, and every failure maps to a fixed state that carries no path or message.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isFileSafeId, isValidSessionId } from "@acr/events";
import { scrubDeep } from "../demo/report.js";
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { secretValues } from "../secrets.js";
import { cleanLine } from "../review/cli-util.js";
import { canView } from "../review/policy.js";
import { readReview } from "../review/review-log.js";
import { loadDrafts } from "../review/draft.js";
import { loadReview, type Loaded } from "../review/store.js";
import { GROUP } from "../review/types.js";
import {
  participantGroupReport,
  renderSubjectMarkdown,
  viewReport,
} from "../review/view.js";

export type ReleasedView = {
  kind: "released";
  own: ParticipantReport;
  group: GroupReport | null;
  markdown: { own: string; group: string | null };
};
export type ReadResult =
  | ReleasedView
  | { kind: "not_released" }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** The secrets list the moderate CLI builds from the environment. */
export const collectSecrets = (env: NodeJS.ProcessEnv): string[] =>
  secretValues(env);

type Located =
  | { k: "found"; dir: string }
  | { k: "missing" }
  | { k: "none" }
  | { k: "unavailable" };

/** `<id>` itself, or `<id>-N` with N 2 to 99 written plainly (evaluate re-runs write these). */
function isCandidate(name: string, id: string): boolean {
  if (name === id) return true;
  if (!name.startsWith(`${id}-`)) return false;
  const n = name.slice(id.length + 1);
  return /^[2-9]$|^[1-9][0-9]$/.test(n);
}

/** Finds the one live (opened, not superseded) review of the session. Never throws. */
async function locate(reportsDir: string, sessionId: string): Promise<Located> {
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId))
    return { k: "missing" };
  try {
    let ents;
    try {
      ents = await readdir(reportsDir, { withFileTypes: true });
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ||
        (e as NodeJS.ErrnoException).code === "ENOTDIR"
        ? { k: "missing" }
        : { k: "unavailable" };
    }
    // Dirent.isDirectory() is false for a symbolic link: a linked folder is never a candidate.
    const names = ents
      .filter((e) => e.isDirectory() && isCandidate(e.name, sessionId))
      .map((e) => e.name)
      .sort();
    if (names.length === 0) return { k: "missing" };
    const live: string[] = [];
    let superseded = 0;
    for (const name of names) {
      const dir = path.join(reportsDir, name);
      const { events } = await readReview(dir);
      const first = events[0];
      if (!first || first.type !== "review.opened") continue;
      if (first.session.id !== sessionId) continue;
      if (events.some((e) => e.type === "review.superseded")) superseded++;
      else live.push(dir);
    }
    if (live.length === 1) return { k: "found", dir: live[0]! };
    if (live.length > 1) return { k: "unavailable" };
    return superseded > 0 ? { k: "unavailable" } : { k: "none" };
  } catch {
    return { k: "unavailable" };
  }
}

export type DraftCandidate = {
  name: string;
  dir: string;
  hasReview: boolean;
  complete: boolean;
};

/**
 * The session's report folders (`<id>`, `<id>-2`..`-99`; real directories only), opened or not, sorted by name. `hasReview` means the
 * folder's log starts with `review.opened`; `complete` means its drafts load and belong to this session. Never throws.
 */
export async function listDraftCandidates(
  reportsDir: string,
  sessionId: string,
): Promise<DraftCandidate[]> {
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) return [];
  try {
    const ents = await readdir(reportsDir, { withFileTypes: true });
    const names = ents
      .filter((e) => e.isDirectory() && isCandidate(e.name, sessionId))
      .map((e) => e.name)
      .sort();
    const out: DraftCandidate[] = [];
    for (const name of names) {
      const dir = path.join(reportsDir, name);
      let hasReview = false;
      try {
        hasReview = (await readReview(dir)).events[0]?.type === "review.opened";
      } catch {
        hasReview = false;
      }
      let complete = false;
      try {
        complete = (await loadDrafts(dir)).sessionId === sessionId;
      } catch {
        complete = false;
      }
      out.push({ name, dir, hasReview, complete });
    }
    return out;
  } catch {
    return [];
  }
}

export type ReviewStatus =
  | { kind: "found"; dir: string }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * Where the session's review stands: the one live review (`found`), nothing to find (`none`: no folder, or no review opened yet),
 * or `unavailable` (two live siblings, a corrupt sibling or log, an unreadable reports folder). Never throws; carries no path.
 */
export async function reviewStatus(
  reportsDir: string,
  sessionId: string,
): Promise<ReviewStatus> {
  const r = await locate(reportsDir, sessionId);
  if (r.k === "found") return { kind: "found", dir: r.dir };
  return r.k === "unavailable" ? { kind: "unavailable" } : { kind: "none" };
}

/** The live, unsuperseded review of the session among `<id>` and `<id>-2`..`-99`; null when none, or when two are live. */
export async function resolveReviewDir(
  reportsDir: string,
  sessionId: string,
): Promise<string | null> {
  const r = await reviewStatus(reportsDir, sessionId);
  return r.kind === "found" ? r.dir : null;
}

const allowed = (l: Loaded, role: string, subject: string): boolean => {
  const sv = l.view.subjects.get(subject);
  if (!sv) return false;
  return canView({
    principal: `participant:${role}`,
    subject,
    state: sv.state,
    versions: sv.versions.length,
    view: "report",
    superseded: l.view.superseded !== null,
    policyVersion: l.view.opened.policyVersion,
  }).allowed;
};

/** One participant's released report (and the group's, when released), as `export --for participant:<role>` would write them. */
export async function readReleasedView(
  reportsDir: string,
  sessionId: string,
  role: string,
  secrets: string[],
): Promise<ReadResult> {
  if (typeof role !== "string" || !isFileSafeId(role) || role === GROUP) {
    // still report a missing folder as missing, so the answer does not depend on the role
    const f = await locate(reportsDir, sessionId);
    return f.k === "missing"
      ? { kind: "missing" }
      : f.k === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "not_released" };
  }
  const f = await locate(reportsDir, sessionId);
  if (f.k === "missing") return { kind: "missing" };
  if (f.k === "unavailable") return { kind: "unavailable" };
  if (f.k === "none") return { kind: "not_released" };
  try {
    const l = await loadReview(f.dir);
    if (l.view.opened.session.id !== sessionId) return { kind: "unavailable" };
    if (l.view.subjects.get(role)?.kind !== "participant")
      return { kind: "not_released" };
    if (!allowed(l, role, role)) return { kind: "not_released" };
    const draftOf = (n: string) =>
      l.drafts.subjects.get(n)!.raw as unknown as
        ParticipantReport | GroupReport;
    const legacy = l.view.opened.legacy;
    const tidy = (md: string): string =>
      `${md
        .split("\n")
        .map((line) => cleanLine(line, secrets))
        .join("\n")
        .trimEnd()}\n`;
    const ownReport = viewReport(draftOf(role), l.view, role, {
      audience: "released",
      line: "Visibility: you and the facilitator",
      legacy,
    });
    let group: GroupReport | null = null;
    let groupMd: string | null = null;
    if (allowed(l, role, GROUP)) {
      const g = participantGroupReport(
        draftOf(GROUP) as GroupReport,
        l.view,
        role,
        "Visibility: the players of this session and the facilitator",
        legacy,
      );
      group = scrubDeep(g, secrets);
      groupMd = tidy(renderSubjectMarkdown(g, secrets));
    }
    return {
      kind: "released",
      own: scrubDeep(ownReport as ParticipantReport, secrets),
      group,
      markdown: {
        own: tidy(renderSubjectMarkdown(ownReport, secrets)),
        group: groupMd,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The participant roles with a released (or amending) report, sorted; null when no review resolves or it cannot be read. */
export async function listReleasedRoles(
  reportsDir: string,
  sessionId: string,
): Promise<string[] | null> {
  const f = await locate(reportsDir, sessionId);
  if (f.k !== "found") return null;
  try {
    const l = await loadReview(f.dir);
    if (l.view.opened.session.id !== sessionId) return null;
    return [...l.view.subjects.values()]
      .filter((s) => s.kind === "participant" && allowed(l, s.id, s.id))
      .map((s) => s.id)
      .sort();
  } catch {
    return null;
  }
}
