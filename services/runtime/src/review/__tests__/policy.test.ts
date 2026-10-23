import { describe, expect, it } from "vitest";
import {
  POLICY,
  canView,
  parsePrincipal,
  redactGroupForParticipant,
  type Principal,
} from "../policy.js";
import type { GroupReport } from "../../evaluator/report-model.js";

const base = {
  versions: 1,
  view: "report" as const,
  superseded: false,
  policyVersion: 1,
};
const P = (p: string) => p as Principal;

describe("canView: released personal report of alice", () => {
  const o = { ...base, subject: "alice", state: "released" as const };
  it.each([
    ["facilitator", true, "none"],
    ["participant:alice", true, "none"],
    ["participant:bob", false, "none"],
    ["line_manager", false, "none"],
    ["ld", false, "none"],
    ["hr", false, "none"],
    ["sponsor", false, "none"],
  ])("%s -> %s", (p, allowed, redact) => {
    expect(canView({ ...o, principal: P(p) })).toMatchObject({
      allowed,
      redact,
    });
  });
});
describe("canView: released group report and index", () => {
  it.each([
    ["facilitator", true, "none"],
    ["participant:alice", true, "peers"],
    ["participant:bob", true, "peers"],
    ["line_manager", false, "none"],
    ["sponsor", false, "none"],
  ])("group, %s", (p, allowed, redact) => {
    expect(
      canView({
        ...base,
        subject: "group",
        state: "released",
        principal: P(p),
      }),
    ).toMatchObject({ allowed, redact });
  });
  it("index follows the same rule", () => {
    expect(
      canView({
        ...base,
        subject: "index",
        view: "index",
        state: "released",
        principal: P("participant:alice"),
      }),
    ).toMatchObject({ allowed: true, redact: "peers" });
  });
});
describe("canView: states other than released", () => {
  it.each([
    ["draft", 0],
    ["withdrawn", 1],
  ] as const)("%s is facilitator only", (state, versions) => {
    for (const p of [
      "participant:alice",
      "line_manager",
      "hr",
      "ld",
      "sponsor",
    ])
      expect(
        canView({ ...base, versions, subject: "alice", state, principal: P(p) })
          .allowed,
      ).toBe(false);
    expect(
      canView({
        ...base,
        versions,
        subject: "alice",
        state,
        principal: "facilitator",
      }).allowed,
    ).toBe(true);
  });
  it("an amendment in progress keeps showing the last released version to the participant", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "amending",
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(true);
  });
  it("a superseded review and a policy version mismatch are facilitator only", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        superseded: true,
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(false);
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        policyVersion: 0,
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(false);
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        superseded: true,
        principal: "facilitator",
      }).allowed,
    ).toBe(true);
  });
  it("never explains a denial with another participant's data", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        principal: P("participant:bob"),
      }).why,
    ).not.toMatch(/alice/);
  });
});
describe("the table", () => {
  it("is the spec policy, version 1", () => {
    expect(POLICY.version).toBe(1);
    expect([...POLICY.personal].sort()).toEqual([
      "facilitator",
      "hr",
      "ld",
      "line_manager",
      "participant",
    ]);
    expect([...POLICY.group].sort()).toEqual([
      "facilitator",
      "hr",
      "ld",
      "line_manager",
      "participant",
      "sponsor",
    ]);
  });
  it("parsePrincipal accepts the closed set and safe role ids only", () => {
    expect(parsePrincipal("participant:alice")).toBe("participant:alice");
    for (const bad of [
      "",
      "participant:",
      "participant:../x",
      "admin",
      "Facilitator",
      "participant:a b",
    ])
      expect(parsePrincipal(bad)).toBeNull();
  });
});
describe("redactGroupForParticipant", () => {
  const group = {
    kind: "group",
    lo_coverage: {
      players: ["alice", "bob"],
      objectives: [
        {
          id: "LO1",
          statement: "s",
          by_role: {
            alice: { score: 3, label: "Proficient", incomplete: false },
            bob: { score: 1.5, label: "Developing", incomplete: false },
          },
          team: { score: 2, label: "Developing", incomplete: false },
        },
      ],
    },
  } as unknown as GroupReport;
  it("keeps only the caller's own row, removes peers entirely and does not modify the input", () => {
    const copy = JSON.stringify(group);
    const r = redactGroupForParticipant(group, "alice");
    expect(r.lo_coverage.players).toEqual(["alice"]);
    expect(Object.keys(r.lo_coverage.objectives[0]!.by_role)).toEqual([
      "alice",
    ]);
    expect(JSON.stringify(r)).not.toContain("bob");
    expect(r.lo_coverage.objectives[0]!.team.score).toBe(2);
    expect(JSON.stringify(group)).toBe(copy);
  });
});

describe("denial is the default", () => {
  const o = { ...base, subject: "alice", state: "released" as const };
  it("denies unknown and malformed principals, including role-id lookalikes", () => {
    for (const bad of [
      "",
      "admin",
      "Facilitator",
      "facilitator ",
      "facilitator\n",
      "participant",
      "participant:",
      "participant:Alice",
      "participant:alice ",
      "participant:alice\n",
      "participant: alice",
      "participant:alice/../bob",
      "participant:alice\\bob",
      "participant:alice\u0000",
      "participant:\u0430lice",
      "participant:\uff41lice",
      "participant:alice:bob",
      "participant:__proto__",
      "participant:constructor",
      "participant:facilitator",
      "participant:group",
      "participant:index",
      "participant:" + "a".repeat(65),
      "PARTICIPANT:alice",
      "lineManager",
    ]) {
      expect(parsePrincipal(bad), JSON.stringify(bad)).toBeNull();
      expect(
        canView({ ...o, principal: bad as Principal }).allowed,
        JSON.stringify(bad),
      ).toBe(false);
      expect(
        canView({ ...o, subject: "group", principal: bad as Principal })
          .allowed,
      ).toBe(false);
    }
  });
  it("denies non-string principals", () => {
    for (const bad of [undefined, null, 7, {}, ["facilitator"]])
      expect(canView({ ...o, principal: bad as never }).allowed).toBe(false);
  });
  it("denies unknown subjects, unknown states and a mismatched view", () => {
    const p = P("participant:alice");
    for (const subject of [
      "",
      "Alice",
      "alice ",
      "../alice",
      "bob",
      "__proto__",
      "alice\n",
    ])
      expect(canView({ ...o, subject, principal: p }).allowed, subject).toBe(
        false,
      );
    expect(
      canView({ ...o, state: "superseded" as never, principal: p }).allowed,
    ).toBe(false);
    expect(
      canView({ ...o, state: "nonsense" as never, principal: p }).allowed,
    ).toBe(false);
    expect(canView({ ...o, view: "x" as never, principal: p }).allowed).toBe(
      false,
    );
    expect(
      canView({ ...o, subject: "alice", view: "index", principal: p }).allowed,
    ).toBe(false);
    expect(
      canView({ ...o, subject: "index", view: "report", principal: p }).allowed,
    ).toBe(false);
    expect(
      canView({ ...o, subject: "../x", principal: "facilitator" }).allowed,
    ).toBe(false);
  });
  it("amending or released with no released snapshot is facilitator only", () => {
    for (const state of ["amending", "released"] as const) {
      expect(
        canView({ ...o, state, versions: 0, principal: P("participant:alice") })
          .allowed,
      ).toBe(false);
      expect(
        canView({ ...o, state, versions: 0, principal: "facilitator" }).allowed,
      ).toBe(true);
    }
    expect(
      canView({ ...o, versions: -1, principal: P("participant:alice") })
        .allowed,
    ).toBe(false);
    expect(
      canView({ ...o, versions: Number.NaN, principal: P("participant:alice") })
        .allowed,
    ).toBe(false);
  });
  it("inert audiences are denied in every state and kind", () => {
    for (const p of ["line_manager", "ld", "hr", "sponsor"])
      for (const state of [
        "draft",
        "released",
        "amending",
        "withdrawn",
      ] as const)
        for (const [subject, view] of [
          ["alice", "report"],
          ["group", "report"],
          ["index", "index"],
        ] as const)
          expect(
            canView({ ...base, subject, view, state, principal: P(p) }).allowed,
          ).toBe(false);
  });
  it("denial reasons are constant strings that never echo input", () => {
    const hostile = "participant:<script>alice</script>";
    const a = canView({ ...o, principal: hostile as Principal });
    expect(a.why).not.toMatch(/script|alice/);
    const b = canView({
      ...o,
      subject: "<img onerror=x>",
      principal: P("participant:bob"),
    });
    expect(b.why).not.toMatch(/img|onerror/);
  });
});

describe("full matrix: literal expectations", () => {
  // columns: principal, subject, view, state, versions, superseded, policyVersion -> allowed, redact
  type Row = [
    string,
    string,
    "report" | "index",
    string,
    number,
    boolean,
    number,
    boolean,
    string,
  ];
  const rows: Row[] = [];
  const add = (
    p: string,
    subj: [string, "report" | "index"],
    st: string,
    v: number,
    sup: boolean,
    pv: number,
    ok: boolean,
    red = "none",
  ) => rows.push([p, subj[0], subj[1], st, v, sup, pv, ok, red]);
  const PERS: [string, "report"] = ["alice", "report"];
  const GRP: [string, "report"] = ["group", "report"];
  const IDX: [string, "index"] = ["index", "index"];
  for (const subj of [PERS, GRP, IDX]) {
    const shared = subj !== PERS;
    // facilitator: always
    for (const st of ["draft", "released", "amending", "withdrawn"])
      add("facilitator", subj, st, 0, true, 0, true);
    // participant:alice
    add(
      "participant:alice",
      subj,
      "released",
      1,
      false,
      1,
      true,
      shared ? "peers" : "none",
    );
    add(
      "participant:alice",
      subj,
      "amending",
      1,
      false,
      1,
      true,
      shared ? "peers" : "none",
    );
    add("participant:alice", subj, "amending", 0, false, 1, false);
    add("participant:alice", subj, "released", 0, false, 1, false);
    add("participant:alice", subj, "draft", 0, false, 1, false);
    add("participant:alice", subj, "withdrawn", 1, false, 1, false);
    add("participant:alice", subj, "released", 1, true, 1, false);
    add("participant:alice", subj, "released", 1, false, 0, false);
    add("participant:alice", subj, "released", 1, false, 2, false);
    // participant:bob
    add(
      "participant:bob",
      subj,
      "released",
      1,
      false,
      1,
      shared,
      shared ? "peers" : "none",
    );
    add(
      "participant:bob",
      subj,
      "amending",
      1,
      false,
      1,
      shared,
      shared ? "peers" : "none",
    );
    add("participant:bob", subj, "released", 0, false, 1, false);
    add("participant:bob", subj, "released", 1, true, 1, false);
    add("participant:bob", subj, "released", 1, false, 0, false);
    add("participant:bob", subj, "draft", 0, false, 1, false);
    add("participant:bob", subj, "withdrawn", 1, false, 1, false);
    // inert audiences
    for (const p of ["line_manager", "ld", "hr", "sponsor"]) {
      add(p, subj, "released", 1, false, 1, false);
      add(p, subj, "amending", 1, false, 1, false);
      add(p, subj, "released", 0, false, 1, false);
      add(p, subj, "released", 1, true, 1, false);
      add(p, subj, "released", 1, false, 0, false);
    }
  }
  it.each(rows)(
    "%s | %s/%s | %s v%i sup=%s pv=%i -> %s %s",
    (
      p,
      subject,
      view,
      state,
      versions,
      superseded,
      policyVersion,
      allowed,
      redact,
    ) => {
      expect(
        canView({
          principal: P(p),
          subject,
          view,
          state: state as never,
          versions,
          superseded,
          policyVersion,
        }),
      ).toMatchObject({ allowed, redact });
    },
  );
});

describe("the table is immutable", () => {
  it("rejects mutation in strict mode", () => {
    "use strict";
    const t = POLICY as unknown as {
      version: number;
      personal: string[];
      group: string[];
    };
    expect(() => {
      t.version = 2;
    }).toThrow();
    expect(() => {
      t.personal.push("sponsor");
    }).toThrow();
    expect(() => {
      t.group.pop();
    }).toThrow();
    expect(() => {
      t.personal[0] = "x";
    }).toThrow();
    expect(
      Object.isFrozen(POLICY) &&
        Object.isFrozen(POLICY.group) &&
        Object.isFrozen(POLICY.personal),
    ).toBe(true);
  });
  it("method, group, index and facilitator are not role ids", () => {
    for (const r of ["method", "group", "index", "facilitator"])
      expect(parsePrincipal("participant:" + r)).toBeNull();
  });
});

describe("redaction drops facilitator-only material", () => {
  const HOSTILE = "HOSTILE-bob-said-secret";
  const g = {
    kind: "group",
    facilitator_notes: HOSTILE + "-notes",
    talking_points: {
      from_scenario: HOSTILE + "-scen",
      from_evaluator: [HOSTILE + "-eval"],
    },
    notable_moments: [
      {
        seq: 3,
        role: "bob",
        quote: "a shared quote",
        note: HOSTILE + "-note",
        scene: 1,
        scene_title: "t",
        time: "00:01",
      },
    ],
    comments: [
      { text: HOSTILE + "-internal", by: "f", visibility: "internal" },
      { text: "kept feedback", by: "f", visibility: "feedback" },
    ],
    lo_coverage: { players: ["alice", "bob"], objectives: [] },
  } as unknown as GroupReport;
  it("none of it survives for a participant, the rest stays", () => {
    const copy = JSON.stringify(g);
    const r = redactGroupForParticipant(g, "alice");
    expect(JSON.stringify(r)).not.toContain("HOSTILE");
    expect(r.notable_moments[0]).toMatchObject({
      quote: "a shared quote",
      role: "bob",
      scene: 1,
    });
    expect(r.comments).toEqual([
      { text: "kept feedback", by: "f", visibility: "feedback" },
    ]);
    expect(r.talking_points).toEqual({ from_scenario: "", from_evaluator: [] });
    expect(r.facilitator_notes).toBe("");
    expect(JSON.stringify(g)).toBe(copy);
  });
  it("the renderer still renders it", async () => {
    const { renderGroupMarkdown } =
      await import("../../evaluator/report-md.js");
    const { buildMethod } = await import("../../evaluator/method.js");
    const full = {
      ...g,
      criteria: [],
      learning_objectives: [],
      evaluation: { status: "ok" },
      notes: [],
      method: buildMethod({ players: 2 }),
      session: { scenes: [] },
      scenario: {},
      evaluator: {},
    } as never;
    expect(() =>
      renderGroupMarkdown(redactGroupForParticipant(full, "alice")),
    ).not.toThrow();
  });
});

describe("redaction properties", () => {
  const mk = (players: string[], by_role: Record<string, unknown>[]) =>
    ({
      kind: "group",
      lo_coverage: {
        players,
        objectives: by_role.map((b, i) => ({
          id: "LO" + i,
          statement: "s",
          by_role: b,
          team: { score: 2, label: "Developing", incomplete: false },
        })),
      },
    }) as unknown as GroupReport;
  const row = (n: number) => ({ score: n, label: "L" + n, incomplete: false });
  const peers = ["bob", "carol", "dave"];
  const shapes: [string, GroupReport][] = [
    [
      "full table",
      mk(
        ["alice", ...peers],
        [{ alice: row(3), bob: row(1), carol: row(2), dave: row(4) }],
      ),
    ],
    [
      "peer absent from players",
      mk(["alice"], [{ alice: row(3), bob: row(1) }]),
    ],
    ["player absent from by_role", mk(["alice", "bob"], [{ bob: row(1) }])],
    ["null rows", mk(["alice", "bob"], [{ alice: null, bob: null }])],
    [
      "own row null, peers present",
      mk(["alice", "bob"], [{ alice: null, bob: row(1) }]),
    ],
    [
      "caller not in table",
      mk(["bob", "carol"], [{ bob: row(1), carol: row(2) }]),
    ],
    ["no objectives", mk(["alice", "bob"], [])],
    [
      "many objectives",
      mk(
        ["alice", "bob"],
        [
          { alice: row(1), bob: row(2) },
          { bob: row(3) },
          { alice: null, carol: row(4) },
        ],
      ),
    ],
    ["empty everything", mk([], [{}])],
  ];
  for (const [name, g] of shapes)
    it("keeps no peer: " + name, () => {
      const copy = JSON.stringify(g);
      const r = redactGroupForParticipant(g, "alice");
      for (const peer of peers)
        expect(JSON.stringify(r), peer).not.toContain(peer);
      for (const pl of r.lo_coverage.players) expect(pl).toBe("alice");
      for (const o of r.lo_coverage.objectives) {
        for (const k of Object.keys(o.by_role)) expect(k).toBe("alice");
        expect(o.team.score).toBe(2);
      }
      expect(JSON.stringify(g)).toBe(copy);
    });
  it("keeps the caller's own row, including a null one", () => {
    const r = redactGroupForParticipant(shapes[3]![1], "alice");
    expect(r.lo_coverage.objectives[0]!.by_role).toEqual({ alice: null });
    expect(r.lo_coverage.players).toEqual(["alice"]);
  });
  it("is not fooled by lookalike or prototype role ids", () => {
    const g = mk(
      ["alice", "Alice", "alice ", "__proto__"],
      [
        {
          alice: row(3),
          Alice: row(1),
          "alice ": row(2),
          ["__proto__"]: row(9),
        },
      ],
    );
    const r = redactGroupForParticipant(g, "alice");
    expect(r.lo_coverage.players).toEqual(["alice"]);
    expect(Object.keys(r.lo_coverage.objectives[0]!.by_role)).toEqual([
      "alice",
    ]);
    const p = redactGroupForParticipant(
      mk(["bob"], [{ bob: row(1) }]),
      "__proto__",
    );
    expect(JSON.stringify(p)).not.toContain("bob");
  });
  it("fails closed on a malformed lo_coverage", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { players: "bob", objectives: "bob" },
      { players: ["bob"], objectives: [null, 3, { by_role: null }] },
    ]) {
      const r = redactGroupForParticipant(
        { kind: "group", lo_coverage: bad } as unknown as GroupReport,
        "alice",
      );
      expect(JSON.stringify(r)).not.toContain("bob");
    }
  });
});
