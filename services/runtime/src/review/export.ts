import {
  link,
  lstat,
  mkdir,
  realpath,
  rmdir,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isSafeId } from "@acr/events";
import { scrubDeep } from "../demo/report.js";
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { REPORT_DIR_MODE, writeExclusive } from "../evaluator/report-write.js";
import type { Ctx } from "./cli.js";
import { cleanLine, facilitator, need, shownName } from "./cli-util.js";
import { renderReviewIndex } from "./index-view.js";
import {
  ReviewCorruptError,
  ReviewRefusedError,
  ReviewUsageError,
} from "./errors.js";
import { canView, parsePrincipal } from "./policy.js";
import { applyCommand, loadReview, type Loaded } from "./store.js";
import { GROUP } from "./types.js";
import {
  participantGroupReport,
  renderSubjectMarkdown,
  snapshotReport,
  viewReport,
} from "./view.js";

/** `export`: write one released report (or `index`) for a principal as owner-only files, recording the export first. */
export async function exportHandler(c: Ctx): Promise<number> {
  const [subject] = c.args;
  if (!subject) throw new ReviewUsageError("export needs <subject>");
  const actor = facilitator(c);
  const principal =
    typeof c.values.for === "string" ? parsePrincipal(c.values.for) : null;
  if (principal === null)
    throw new ReviewUsageError("--for needs facilitator or participant:<role>");
  if (typeof c.values.to !== "string" || c.values.to === "")
    throw new ReviewUsageError("--to needs a destination directory");
  const dest = path.resolve(c.base, c.values.to);
  const label = isSafeId(path.basename(dest))
    ? path.basename(dest)
    : "destination";
  const isIndex = subject === "index";
  // An index export is audited under the group (the export event needs a released subject); the index follows the group's state.
  const audited = isIndex ? GROUP : subject;
  const names = isIndex ? ["index.md"] : [`${subject}.md`, `${subject}.json`];
  const role = principal.startsWith("participant:")
    ? principal.slice("participant:".length)
    : null;
  /** Who may export what, against one loaded view. Messages are constants: nothing from the request is echoed. */
  const gate = (l: Loaded) => {
    const sv = need(l.view.subjects.get(audited), "subject");
    if (role !== null && l.view.subjects.get(role)?.kind !== "participant")
      throw new ReviewRefusedError("that participant is not in this review");
    if (principal === "facilitator") {
      if (sv.state !== "released")
        throw new ReviewRefusedError(
          `${isIndex ? GROUP : subject} is ${sv.state}; only a released report is exported`,
        );
    } else {
      const access = canView({
        principal,
        subject,
        state: sv.state,
        versions: sv.versions.length,
        view: isIndex ? "index" : "report",
        superseded: l.view.superseded !== null,
        policyVersion: l.view.opened.policyVersion,
      });
      if (!access.allowed)
        throw new ReviewRefusedError(`export refused: ${access.why}`);
    }
    return sv;
  };
  const l = await loadReview(c.dir);
  gate(l);
  // Refuse before auditing what we can already see is unwritable: a symbolic-link or non-directory destination, or a file already there.
  const existing = await lstat(dest).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new ReviewRefusedError(
      "the destination exists and is not a plain directory (symbolic links are never followed); nothing was exported",
    );
  if (existing)
    for (const n of names)
      if (await lstat(path.join(dest, n)).catch(() => null))
        throw new ReviewRefusedError(
          `the destination already holds ${shownName(n)}; files are never overwritten; nothing was exported`,
        );
  // The audit event comes first (P17): a record of an export that then failed is safer than an export nobody recorded.
  // Version and content are both taken from the locked view inside the callback, so they always belong together.
  const files: string[] = [];
  const tidy = (md: string): string =>
    `${md
      .split("\n")
      .map((line) => cleanLine(line, c.secrets))
      .join("\n")
      .trimEnd()}\n`;
  await applyCommand(c.dir, c.now, (cur) => {
    const sv = gate(cur);
    files.length = 0;
    const draftOf = (n: string) =>
      cur.drafts.subjects.get(n)!.raw as unknown as
        ParticipantReport | GroupReport;
    if (isIndex) {
      files.push(
        tidy(
          renderReviewIndex(
            cur,
            role === null
              ? { audience: "facilitator" }
              : { audience: "participant", role },
            c.secrets,
          ),
        ),
      );
    } else {
      // as strict as `show`: per line, hidden and control characters out, secrets and machine paths redacted (tables and tabs stay)
      let report: ParticipantReport | GroupReport;
      if (role === null)
        report = snapshotReport(draftOf(subject), cur.view, subject);
      else {
        const line =
          subject === GROUP
            ? "Visibility: the players of this session and the facilitator"
            : "Visibility: you and the facilitator";
        const legacy = cur.view.opened.legacy;
        report =
          subject === GROUP
            ? participantGroupReport(
                draftOf(subject) as GroupReport,
                cur.view,
                role,
                line,
                legacy,
              )
            : viewReport(draftOf(subject), cur.view, subject, {
                audience: "released",
                line,
                legacy,
              });
      }
      files.push(
        tidy(renderSubjectMarkdown(report, c.secrets)),
        `${JSON.stringify(scrubDeep(report, c.secrets), null, 2)}\n`,
      );
    }
    return [
      {
        actor,
        body: {
          type: "report.exported",
          subject: audited,
          version: sv.versions.at(-1)!,
          principal,
          destination: label,
        },
      },
    ];
  });
  const finals: string[] = [];
  const temps: string[] = [];
  let created = false;
  try {
    // Exclusive creation: parents may be made, the destination itself must not exist (EEXIST refuses, nothing is deleted).
    if (!existing) {
      await mkdir(path.dirname(dest), {
        recursive: true,
        mode: REPORT_DIR_MODE,
      });
      await mkdir(dest, { mode: REPORT_DIR_MODE });
      created = true;
    }
    // A destination swapped for a symbolic link since the check is refused (a residual window remains between this check and the writes).
    const here = await lstat(dest);
    if (
      here.isSymbolicLink() ||
      (await realpath(dest)) !==
        path.join(await realpath(path.dirname(dest)), path.basename(dest))
    )
      throw new Error("destination is not a plain directory");
    const tag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Stage every file under a private temp name (created exclusively, owner-only), then link each into place: link never
    // replaces an existing name or follows a symlink there, so a late-appearing file fails the export instead of being overwritten.
    const staged: [string, string][] = [];
    for (const [i, n] of names.entries()) {
      const t = files[i]!;
      const tmp = path.join(dest, `.${n}.${tag}.tmp`);
      await writeExclusive(tmp, t);
      temps.push(tmp);
      staged.push([tmp, path.join(dest, n)]);
    }
    for (const [tmp, fin] of staged) {
      await link(tmp, fin);
      finals.push(fin);
    }
    for (const tmp of temps) await unlink(tmp);
  } catch {
    // Remove only what this run made; the directory only if this run created it and it is now empty (never a recursive delete).
    for (const f of [...finals, ...temps])
      await rm(f, { force: true }).catch(() => undefined);
    if (created) await rmdir(dest).catch(() => undefined);
    throw new ReviewCorruptError(
      "an export event was recorded in the review but no files were produced (the destination could not be written, or a file appeared there); nothing was left behind",
    );
  }
  c.out(`exported ${subject} to ${label}`);
  return 0;
}
