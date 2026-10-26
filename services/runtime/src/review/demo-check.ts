import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POLICY, canView, type Principal } from "./policy.js";
import { loadReview } from "./store.js";
import { runModerate } from "./cli.js";
import { GROUP } from "./types.js";

const BY = "s17";
const TEXT_INTERNAL = "S17-INTERNAL-NOTE";
const TEXT_POST_RELEASE = "S17-POST-RELEASE-FEEDBACK";
const TEXT_GROUP_INTERNAL = "S17-GROUP-INTERNAL-NOTE";
const TEXT_AMEND_EDIT = "S17-AMEND-RATIONALE";
const TEXT_FEEDBACK = "S17-FEEDBACK-NOTE";
const TEXT_REASON = "S17-EDIT-REASON";
const TEXT_SELF_ME = "S17-SELF-NOTE-OWN";
const TEXT_SELF_PEER = "S17-SELF-NOTE-PEER";
const TEXT_RESP_ME = "S17-RESPONSE-OWN";
const TEXT_RESP_PEER = "S17-RESPONSE-PEER";
const TEXT_RESOLVE_PEER = "S17-RESOLUTION-PEER";
/** Fields that exist only while a report is being reviewed; a participant's files must never carry them. */
const REVIEW_STATE_KEYS = [
  "summary_state",
  "rationale_edited",
  "accepted",
  "accepted_by",
  "needs_review",
  "summary_stale",
  "table_stale",
  "snapshot",
  "versions",
];

function fail(msg: string): never {
  throw new Error(`review check: ${msg}`);
}
function ensure(ok: boolean, msg: string): asserts ok {
  if (!ok) fail(msg);
}
const keysOf = (v: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, into));
  else if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v)) {
      into.add(k);
      keysOf(x, into);
    }
  return into;
};

/**
 * The offline S-17 check: runs the real moderation path on a COPY of an evaluator draft directory in a private temp directory
 * (open, edit, accept, comment, release, export for the facilitator and for each participant, amend, withdraw) and asserts the
 * privacy invariants against what was actually written. The draft directory itself is never modified. Throws with what failed.
 */
export async function runReviewCheck(
  draftDir: string,
  o: { now: () => number },
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acr-s17-"));
  try {
    const work = path.join(root, "draft");
    await mkdir(work, { mode: 0o700 });
    const names = (await readdir(draftDir)).filter(
      (n) => n.endsWith(".md") || n.endsWith(".json"),
    );
    ensure(names.length > 0, "the draft directory holds no report files");
    for (const n of names)
      await copyFile(path.join(draftDir, n), path.join(work, n));

    const run = async (
      argv: string[],
    ): Promise<{ code: number; err: string }> => {
      let err = "";
      const r = await runModerate({
        argv,
        stdout: { write: () => true },
        stderr: { write: (s) => ((err += s), true) },
        env: {},
        cwd: root,
        now: o.now,
      });
      return { code: r.exitCode, err };
    };
    const must = async (what: string, argv: string[]) => {
      const r = await run(argv);
      ensure(
        r.code === 0,
        `${what} failed (exit ${r.code}): ${r.err.trim().split("\n")[0]}`,
      );
    };
    const mustRefuse = async (what: string, argv: string[]) => {
      const r = await run(argv);
      ensure(r.code === 1, `${what} was not refused (exit ${r.code})`);
    };
    const rel = "draft";
    const resolveAll = async () => {
      const l = await loadReview(work);
      for (const sv of l.view.subjects.values()) {
        for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
          await must("accept", ["accept", rel, sv.id, c.id, "--by", BY]);
        const cur = (await loadReview(work)).view.subjects.get(sv.id)!;
        if (cur.summaryStale)
          await must("accept summary", [
            "accept",
            rel,
            sv.id,
            "--summary",
            "--by",
            BY,
          ]);
      }
    };

    await must("open", ["open", rel, "--by", BY]);
    const opened = await loadReview(work);
    const roles = [...opened.view.subjects.values()]
      .filter((s) => s.kind === "participant")
      .map((s) => s.id);
    const subjects = opened.view.subjects.size;
    ensure(
      roles.length >= 2,
      "the draft needs at least two players to check peer privacy",
    );

    // The gate: nothing is released while a criterion needs review.
    await mustRefuse("release with open criteria", [
      "release",
      rel,
      "--all",
      "--by",
      BY,
    ]);
    ensure(
      !(await loadReview(work)).events.some(
        (e) => e.type === "report.released",
      ),
      "a release was recorded while criteria still needed review",
    );

    // Moderate the first player: one edit with a reason, an internal and a feedback comment.
    const [me, peer] = roles as [string, string];
    const mine = opened.view.subjects.get(me)!;
    const c0 = mine.criteria[0]!;
    await must("edit", [
      "edit",
      rel,
      me,
      c0.id,
      "--level",
      c0.current === 4 ? "3" : "4",
      "--reason",
      TEXT_REASON,
      "--by",
      BY,
    ]);
    await must("internal comment", [
      "comment",
      rel,
      me,
      "--text",
      TEXT_INTERNAL,
      "--by",
      BY,
    ]);
    await must("feedback comment", [
      "comment",
      rel,
      me,
      "--text",
      TEXT_FEEDBACK,
      "--feedback",
      "--by",
      BY,
    ]);
    await must("group internal comment", [
      "comment",
      rel,
      GROUP,
      "--text",
      TEXT_GROUP_INTERNAL,
      "--by",
      BY,
    ]);
    // Blind self-ratings (facilitator-attested) before the release, one per player.
    for (const [r, note] of [
      [me, TEXT_SELF_ME],
      [peer, TEXT_SELF_PEER],
    ] as const)
      await must("self-assess", [
        "self-assess",
        rel,
        "--role",
        r,
        "--rate",
        `${opened.view.subjects.get(r)!.criteria[0]!.id}=2`,
        "--note",
        note,
        "--by",
        BY,
      ]);
    await mustRefuse("a response before the release", [
      "respond",
      rel,
      "--role",
      me,
      "--text",
      TEXT_RESP_ME,
      "--by",
      BY,
    ]);
    await resolveAll();
    await must("release", ["release", rel, "--all", "--by", BY]);
    await mustRefuse("a self-rating after the release", [
      "self-assess",
      rel,
      "--role",
      me,
      "--rate",
      `${c0.id}=3`,
      "--by",
      BY,
    ]);
    const released = (await loadReview(work)).events.filter(
      (e) => e.type === "report.released",
    );
    ensure(
      released.length === 1,
      `${released.length} release events were recorded, expected one`,
    );
    ensure(
      (released[0] as { subjects: string[] }).subjects.length === subjects,
      "the release did not cover every subject",
    );
    await must("post-release comment", [
      "comment",
      rel,
      me,
      "--text",
      TEXT_POST_RELEASE,
      "--feedback",
      "--by",
      BY,
    ]);

    // Responses and a resolved dispute after the release: the player's own report and the facilitator's view carry them, nobody else's does.
    await must("response", [
      "respond",
      rel,
      "--role",
      me,
      "--text",
      TEXT_RESP_ME,
      "--by",
      BY,
    ]);
    await must("peer dispute", [
      "respond",
      rel,
      "--role",
      peer,
      "--text",
      TEXT_RESP_PEER,
      "--dispute",
      "--by",
      BY,
    ]);
    const disputeSeq = (await loadReview(work)).events.find(
      (e) =>
        e.type === "response.added" && (e as { role: string }).role === peer,
    )!.seq;
    await mustRefuse("resolving a dispute as amended before any amend", [
      "resolve",
      rel,
      String(disputeSeq),
      "--outcome",
      "amended",
      "--reason",
      TEXT_RESOLVE_PEER,
      "--by",
      BY,
    ]);
    await must("resolve", [
      "resolve",
      rel,
      String(disputeSeq),
      "--outcome",
      "declined",
      "--reason",
      TEXT_RESOLVE_PEER,
      "--by",
      BY,
    ]);

    // The access matrix, against the table of the audience policy.
    const loaded = await loadReview(work);
    const principals: Principal[] = [
      "facilitator",
      ...roles.map((r) => `participant:${r}` as Principal),
      "line_manager",
      "ld",
      "hr",
      "sponsor",
    ];
    const targets = [...roles, GROUP, "index"];
    let cells = 0;
    for (const p of principals) {
      for (const t of targets) {
        const isIndex = t === "index";
        const sv = loaded.view.subjects.get(isIndex ? GROUP : t)!;
        const got = canView({
          principal: p,
          subject: t,
          state: sv.state,
          versions: sv.versions.length,
          view: isIndex ? "index" : "report",
          superseded: loaded.view.superseded !== null,
          policyVersion: POLICY.version,
        });
        const expected =
          p === "facilitator" ||
          (p.startsWith("participant:") &&
            (!roles.includes(t) || p === `participant:${t}`));
        ensure(
          got.allowed === expected,
          `access matrix: ${p} on ${t} was ${got.allowed ? "allowed" : "denied"}, expected ${expected ? "allowed" : "denied"}`,
        );
        const peers = p.startsWith("participant:") && (t === GROUP || isIndex);
        ensure(
          !got.allowed || got.redact === (peers ? "peers" : "none"),
          `access matrix: ${p} on ${t} has the wrong redaction (${got.redact})`,
        );
        cells++;
      }
    }

    // Exports: the facilitator's and each participant's own.
    const ex = (subject: string, who: string, to: string) =>
      must(`export ${subject} for ${who}`, [
        "export",
        rel,
        subject,
        "--for",
        who,
        "--to",
        to,
        "--by",
        BY,
      ]);
    const read = (p: string) => readFile(path.join(root, p), "utf8");
    await ex(me, "facilitator", "out/fac");
    ensure(
      (await read(`out/fac/${me}.md`)).includes(TEXT_INTERNAL),
      "the facilitator export lost the internal comment (the check would be vacuous)",
    );
    const who = `participant:${me}`;
    await ex(me, who, "out/p1");
    await ex(GROUP, who, "out/p2");
    await ex("index", who, "out/p3");
    await mustRefuse(`${who} exporting a peer's report`, [
      "export",
      rel,
      peer,
      "--for",
      who,
      "--to",
      "out/p4",
      "--by",
      BY,
    ]);

    // What a participant's files may not hold.
    type D = {
      criteria: { rationale?: string; evidence?: { quote?: string }[] }[];
    };
    const strings = async (r: string) => {
      const d = JSON.parse(
        await readFile(path.join(work, `${r}.json`), "utf8"),
      ) as D;
      return d.criteria.flatMap((c) => [
        c.rationale ?? "",
        ...(c.evidence ?? []).map((e) => e.quote ?? ""),
      ]);
    };
    // Only text that is the peer's own: a line both players said is not a leak.
    const mineStrings = new Set(await strings(me));
    const peerStrings = (await strings(peer)).filter(
      (s) => s.length >= 12 && !mineStrings.has(s),
    );
    ensure(
      peerStrings.length > 0,
      "the peer has no quote or rationale to look for (the check would be vacuous)",
    );
    // Facilitator-directed material of the source group draft: none of it may be in the participant's group export.
    const gd = JSON.parse(
      await readFile(path.join(work, "group.json"), "utf8"),
    ) as {
      facilitator_notes?: string;
      talking_points?: { from_scenario?: string; from_evaluator?: string[] };
      notable_moments?: { note?: string }[];
    };
    const tp = gd.talking_points as unknown;
    const directed = [
      gd.facilitator_notes,
      ...(Array.isArray(tp)
        ? (tp as string[])
        : [
            (tp as { from_scenario?: string } | undefined)?.from_scenario,
            ...((tp as { from_evaluator?: string[] } | undefined)
              ?.from_evaluator ?? []),
          ]),
      ...(gd.notable_moments ?? []).map((m) => m.note),
    ].filter((x): x is string => typeof x === "string" && x.length >= 8);
    ensure(
      directed.length > 0,
      "the group draft has no facilitator-directed text to look for (the check would be vacuous)",
    );
    const files: Record<string, string> = {};
    for (const d of ["out/p1", "out/p2", "out/p3"])
      for (const n of await readdir(path.join(root, d)))
        files[`${d}/${n}`] = await read(`${d}/${n}`);
    for (const f of Object.keys(files).filter((n) =>
      /\/group\.(md|json)$/.test(n),
    ))
      for (const x of directed)
        ensure(
          !files[f]!.includes(x) &&
            !files[f]!.includes(JSON.stringify(x).slice(1, -1)),
          `${f} carries facilitator-directed text of the group draft`,
        );
    ensure(
      Object.keys(files).length >= 4,
      "the participant exports are missing files",
    );
    for (const [f, text] of Object.entries(files)) {
      // The group report's notable moments keep their quotes by design (the quote, role and scene stay for everyone); personal files and the index may not.
      for (const s of /\/group\.(md|json)$/.test(f) ? [] : peerStrings)
        ensure(!text.includes(s), `${f} carries a peer's quote or rationale`);
      // Self-ratings and responses belong to their author's own report: a peer's never appear, and the author's own appear only there.
      for (const t of [TEXT_SELF_PEER, TEXT_RESP_PEER, TEXT_RESOLVE_PEER])
        ensure(
          !text.includes(t),
          `${f} carries a peer's self-rating or response`,
        );
      if (!f.includes(`/${me}.`))
        for (const t of [TEXT_SELF_ME, TEXT_RESP_ME])
          ensure(
            !text.includes(t),
            `${f} carries the player's self-rating or response outside their own report`,
          );
      for (const t of [TEXT_INTERNAL, TEXT_POST_RELEASE, TEXT_GROUP_INTERNAL])
        ensure(
          !text.includes(t),
          `${f} carries an internal comment or one made after the release`,
        );
      if (f.endsWith(".md") && !f.endsWith("group.md"))
        ensure(
          !new RegExp(`\\b${peer}\\b`, "i").test(text),
          `${f} names a peer`,
        );
      if (f.endsWith(".json")) {
        const j: unknown = JSON.parse(text);
        const k = keysOf(j);
        for (const bad of REVIEW_STATE_KEYS)
          ensure(!k.has(bad), `${f} carries the review-state field ${bad}`);
        const marked =
          JSON.stringify(j).includes('"moderation":{') &&
          /"moderation":\{[^}]*"state":/.test(JSON.stringify(j));
        ensure(!marked, `${f} carries a per-criterion review state`);
        for (const r of roles.filter((x) => x !== me))
          ensure(!k.has(r), `${f} has a key for the peer ${r}`);
      }
    }
    ensure(
      (await read("out/p1/" + me + ".md")).includes(TEXT_FEEDBACK),
      "the participant's own feedback comment is missing",
    );
    for (const t of [TEXT_SELF_ME, TEXT_RESP_ME])
      ensure(
        (await read("out/p1/" + me + ".md")).includes(t),
        "the participant's own self-rating or response is missing (the check would be vacuous)",
      );
    const groupJson = JSON.parse(files["out/p2/group.json"]!) as {
      lo_coverage: {
        players: string[];
        objectives: { by_role: Record<string, unknown> }[];
      };
    };
    ensure(
      groupJson.lo_coverage.players.every((p) => p === me),
      "the group report lists a peer",
    );
    for (const ob of groupJson.lo_coverage.objectives)
      ensure(
        Object.keys(ob.by_role).every((r) => r === me),
        "the group report holds a peer's result",
      );

    // Amend the peer: the participant keeps the last release until it is re-released.
    await ex(peer, `participant:${peer}`, "out/pre");
    for (const ext of ["md", "json"]) {
      const theirs = await read(`out/pre/${peer}.${ext}`);
      for (const t of [TEXT_SELF_ME, TEXT_RESP_ME])
        ensure(
          !theirs.includes(t),
          `${peer}'s own export carries another player's self-rating or response`,
        );
      ensure(
        theirs.includes(TEXT_RESP_PEER),
        "the peer's own export lacks their response (the check would be vacuous)",
      );
    }
    await must("amend", [
      "amend",
      rel,
      peer,
      "--reason",
      TEXT_REASON,
      "--by",
      BY,
    ]);
    const pc = (await loadReview(work)).view.subjects.get(peer)!.criteria[0]!;
    await must("edit during the amendment", [
      "edit",
      rel,
      peer,
      pc.id,
      "--level",
      pc.current === 4 ? "3" : "4",
      "--rationale",
      TEXT_AMEND_EDIT,
      "--reason",
      TEXT_REASON,
      "--by",
      BY,
    ]);
    await ex(peer, `participant:${peer}`, "out/amend");
    for (const ext of ["md", "json"]) {
      const before = await read(`out/pre/${peer}.${ext}`);
      const during = await read(`out/amend/${peer}.${ext}`);
      ensure(
        !during.includes(TEXT_AMEND_EDIT),
        `the ${ext} export during an amendment carries the unreleased edit`,
      );
      ensure(
        during === before,
        `the ${ext} export during an amendment differs from the last release`,
      );
    }
    await must("withdraw", [
      "withdraw",
      rel,
      me,
      "--reason",
      TEXT_REASON,
      "--by",
      BY,
    ]);
    await mustRefuse(`${who} exporting their withdrawn report`, [
      "export",
      rel,
      me,
      "--for",
      who,
      "--to",
      "out/w1",
      "--by",
      BY,
    ]);
    await ex(GROUP, who, "out/w2");
    const gw = JSON.parse(await read("out/w2/group.json")) as typeof groupJson;
    ensure(
      gw.lo_coverage.players.length === 0,
      "a withdrawn player's own row is still in their group report",
    );
    for (const ob of gw.lo_coverage.objectives)
      ensure(
        Object.keys(ob.by_role).length === 0,
        "a withdrawn player's result is still in their group report",
      );

    // The audit trail: every export is in the log.
    const final = await loadReview(work);
    const exports = final.events.filter(
      (e) => e.type === "report.exported",
    ).length;
    ensure(
      exports === 7,
      `${exports} exports are recorded, expected 7 (refused exports record nothing)`,
    );

    return `${subjects} subjects reviewed and released in one event; access matrix ${cells} cells checked; peers' results absent from ${me}'s group report; ${exports} exports recorded, amend and withdraw honoured`;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
