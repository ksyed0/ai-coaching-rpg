import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { assignSplit, lintProbeSet, loadProbes, MIN_SET_PROBES, printable } from "../probe-load.js";
import type { Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCEN = path.join(REPO, "scenarios/friday-escalation");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); await mkdir(path.join(dir, "calibration"), { recursive: true }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ctx() {
  const scenario = await loadScenario(SCEN);
  const { rubrics } = await loadRubrics(SCEN, scenario);
  return { scenario, rubrics };
}
const yaml = (o: string) => o.replace(/^\n/, "");
const good = yaml(`
kind: single
id: p1
criterion: discovery
source: handwritten
split: tune
subject: delivery_lead
expected: 1
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "Can you confirm by Friday?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that." }
  - { scene: s2_client_call, role: delivery_lead, text: "Consider it done." }
`);

/** A valid contrast probe; with a key, one more player under that key (a prototype-like name that the schema's own id check accepts). */
const PROTO_KEY = ["con", "structor"].join("");
const protoProbe = (id: string, key: string | null): string => yaml(`
kind: contrast
id: ${id}
criterion: listening
source: handwritten
split: tune
players: { delivery_lead: 4, account_manager: 1${key ? `, ${key}: 2` : ""} }
min_gap: 2
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "Can you confirm by Friday?" }
  - { scene: s2_client_call, role: delivery_lead, text: "So the deadline is Friday; what drives it?" }
  - { scene: s2_client_call, role: account_manager, text: "Just say yes." }
  - { scene: s2_client_call, role: delivery_lead, text: "Let us look at what Friday needs." }
  - { scene: s2_client_call, role: account_manager, text: "Yes, yes." }
`);

describe("loadProbes", () => {
  it("returns no probes and a warning when there is no calibration directory", async () => {
    const { scenario, rubrics } = await ctx();
    const r = await loadProbes(path.join(dir, "nope"), scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no calibration directory/);
  });
  it("loads a valid probe", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes.map((p) => p.id)).toEqual(["p1"]);
  });
  it("reports every problem in one list", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good.replace("criterion: discovery", "criterion: nonexistent"));
    await writeFile(path.join(dir, "calibration", "p2.yaml"), good.replace("id: p1", "id: p2").replace("subject: delivery_lead", "subject: client_sponsor"));
    await writeFile(path.join(dir, "calibration", "p3.yaml"), good.replace("id: p1", "id: other"));
    await writeFile(path.join(dir, "calibration", "p4.yaml"), good.replace("id: p1", "id: p4").replace(/ {2}- \{ scene: s2_client_call, role: delivery_lead, text: "Consider it done." \}\n/, ""));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/p1.yaml.*criterion/s);
    expect(r.errors.join("\n")).toMatch(/p2.yaml.*player/s);
    expect(r.errors.join("\n")).toMatch(/p3.yaml.*id.*file name/s);
    expect(r.errors.join("\n")).toMatch(/p4.yaml.*at least 2/s);
  });
  it("refuses an oversized file, an alias bomb and a prototype key, each for its own reason", async () => {
    const { scenario, rubrics } = await ctx();
    const cal = path.join(dir, "calibration");
    await writeFile(path.join(cal, "big.yaml"), good.replace("id: p1", "id: big") + "# " + "a".repeat(200 * 1024) + "\n");
    const anchored = good.replace("id: p1", "id: bomb").replace(
      '  - { scene: s2_client_call, role: delivery_lead, text: "Consider it done." }\n',
      '  - &l { scene: s2_client_call, role: delivery_lead, text: "Consider it done." }\n' + "  - *l\n".repeat(12),
    );
    await writeFile(path.join(cal, "bomb.yaml"), anchored);
    await writeFile(path.join(cal, "proto.yaml"), protoProbe("proto", PROTO_KEY));
    // the same probe files without the hostile part load cleanly, so only the defences can refuse them
    await writeFile(path.join(cal, "ok.yaml"), good.replace("id: p1", "id: ok"));
    await writeFile(path.join(cal, "ok2.yaml"), protoProbe("ok2", null));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes.map((p) => p.id).sort()).toEqual(["ok", "ok2"]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.find((e) => e.startsWith("big.yaml:"))).toMatch(/larger than/);
    expect(r.errors.find((e) => e.startsWith("bomb.yaml:"))).toMatch(/alias/i);
    expect(r.errors.find((e) => e.startsWith("proto.yaml:"))).toMatch(/prototype key/);
  });
  it("reports every schema problem of a file, up to five, with a count of the rest", async () => {
    const { scenario, rubrics } = await ctx();
    const cal = path.join(dir, "calibration");
    await writeFile(path.join(cal, "bad.yaml"), good.replace("id: p1", "id: Bad Id").replace("criterion: discovery", "criterion: Not Ok").replace("split: tune", "split: neither"));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toHaveLength(1);
    const line = r.errors[0]!;
    expect(line).toMatch(/^bad\.yaml: /);
    expect(line).toMatch(/id /);
    expect(line).toMatch(/criterion /);
    expect(line).toMatch(/split /);
    expect(line.split("; ").length).toBe(3);
    await writeFile(path.join(cal, "bad.yaml"), good.replace("source: handwritten", "source: nope").replace("split: tune", "split: neither") + 'drafter: ""\napproved_by: ""\napproved_at: ""\nid2: 1\n');
    const r2 = await loadProbes(dir, scenario, rubrics);
    expect(r2.errors).toHaveLength(1);
    expect(r2.errors[0]).toMatch(/ \(\+1 more\)$/);
    expect(r2.errors[0]!.replace(/ \(\+1 more\)$/, "").replace(/^bad\.yaml: /, "").split("; ")).toHaveLength(5);
  });
  it("refuses a calibration directory that is a symbolic link", async () => {
    const { scenario, rubrics } = await ctx();
    const real = path.join(dir, "real");
    await mkdir(real);
    await writeFile(path.join(real, "p1.yaml"), good);
    await rm(path.join(dir, "calibration"), { recursive: true });
    await symlink(real, path.join(dir, "calibration"));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors).toEqual(["calibration directory must not be a symbolic link"]);
  });
  it("returns an error instead of throwing when calibration is a file", async () => {
    const { scenario, rubrics } = await ctx();
    await rm(path.join(dir, "calibration"), { recursive: true });
    await writeFile(path.join(dir, "calibration"), "x");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/not a directory/);
  });
  it("does not follow a symbolic link probe file and warns about a .yml file", async () => {
    const { scenario, rubrics } = await ctx();
    const cal = path.join(dir, "calibration");
    await writeFile(path.join(dir, "outside.txt"), good.replace("id: p1", "id: link"));
    await symlink(path.join(dir, "outside.txt"), path.join(cal, "link.yaml"));
    await writeFile(path.join(cal, "p1.yml"), good);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors).toContain("link.yaml: symbolic links are not followed");
    expect(r.warnings).toContain("p1.yml: ignored (probe files must end in .yaml)");
  });
  it("keeps escape sequences and newlines from untrusted names out of messages", async () => {
    const { scenario, rubrics } = await ctx();
    const cal = path.join(dir, "calibration");
    const evil = "\u001b[2J\nFAKE OK";
    await writeFile(path.join(cal, `${evil}.yaml`), good);
    await writeFile(path.join(cal, `${evil}.yml`), good);
    // YAML escapes keep the key on one line: it parses, reaches zod, and zod names it in its unrecognized-key message and path
    const yamlEvil = String.raw`\e[2J\nFAKE OK`;
    await writeFile(path.join(cal, "k.yaml"), good.replace("id: p1", "id: k") + `"${yamlEvil}${"z".repeat(300)}": 1\n`);
    await writeFile(path.join(cal, "pk.yaml"), protoProbe("pk", null).replace("account_manager: 1 }", `account_manager: 1, "${yamlEvil}": 3 }`));
    const r = await loadProbes(dir, scenario, rubrics);
    const lines = [...r.errors, ...r.warnings];
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) {
      expect(l).not.toContain("\u001b");
      expect(l).not.toContain("\n");
      expect(l.length).toBeLessThan(400);
    }
    const k = r.errors.find((e) => e.startsWith("k.yaml:"));
    expect(k).toMatch(/Unrecognized key/i);
    expect(k).toContain("FAKE OK");
    const pk = r.errors.find((e) => e.startsWith("pk.yaml:"));
    expect(pk).toMatch(/^pk\.yaml: players\.·\[2J·FAKE OK /);
  });
  it("turns YAML warnings into probe errors and writes nothing to process stderr", async () => {
    const { scenario, rubrics } = await ctx();
    const hostile = good.replace("expected: 1", "expected: !!js/function 'x\u001b[2J'");
    await writeFile(path.join(dir, "calibration", "p1.yaml"), hostile);
    const emit = vi.spyOn(process, "emitWarning");
    const write = vi.spyOn(process.stderr, "write");
    try {
      const r = await loadProbes(dir, scenario, rubrics);
      expect(emit).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(r.probes).toEqual([]);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^p1\.yaml: .*Unresolved tag/);
      expect(r.errors[0]).not.toContain("\u001b");
    } finally { emit.mockRestore(); write.mockRestore(); }
  });
  it("warns, without refusing, when a player who is not scored speaks twice or more", async () => {
    const { scenario, rubrics } = await ctx();
    const cal = path.join(dir, "calibration");
    // account_manager speaks twice and is not the subject; client_sponsor (an NPC) speaks twice and is not a player, tech_lead once
    await writeFile(path.join(cal, "p1.yaml"), good.replace(
      '  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that." }\n',
      '  - { scene: s2_client_call, role: account_manager, text: "Sure." }\n  - { scene: s2_client_call, role: account_manager, text: "Agreed." }\n  - { scene: s2_client_call, role: client_sponsor, text: "Thanks." }\n  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that." }\n',
    ));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toHaveLength(1);
    expect(r.warnings).toContain("p1.yaml: account_manager speaks 2 times but is not scored (costs a model call); give them one line or make them a subject");
    expect(r.warnings.filter((w) => w.includes("not scored"))).toHaveLength(1);
  });
  it("does not warn about a scored player or a player with one line", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good);
    await writeFile(path.join(dir, "calibration", "c1.yaml"), protoProbe("c1", null));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.includes("not scored"))).toEqual([]);
  });
  it("refuses a line from a role that is not a participant of the line's scene", async () => {
    const { scenario, rubrics } = await ctx();
    // tech_lead is in s1_huddle but not in s2_client_call
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good.replace("role: client_sponsor", "role: tech_lead"));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors).toEqual(["p1.yaml: tech_lead is not a participant of scene s2_client_call"]);
  });
  it("does not add a participant error for an unknown scene or role (those have their own message)", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good.replace("role: client_sponsor", "role: nobody").replace("scene: s2_client_call, role: delivery_lead, text: \"Yes", "scene: nowhere, role: delivery_lead, text: \"Yes"));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors.join("\n")).toMatch(/unknown role nobody/);
    expect(r.errors.join("\n")).toMatch(/unknown scene nowhere/);
    expect(r.errors.join("\n")).not.toMatch(/not a participant/);
  });
  it("refuses a line that contains a hidden fact of a role, never printing the fact or the line", async () => {
    const { scenario, rubrics } = await ctx();
    const fact = "The budget ceiling is exactly 1.2 million pounds";
    const sc = { ...scenario, roles: { ...scenario.roles, client_sponsor: { ...scenario.roles.client_sponsor!, hidden: [fact, "too short"] } } } as typeof scenario;
    const leak = good.replace("Can you confirm by Friday?", "Well,   THE budget ceiling\tis exactly 1.2 million   pounds, so no.");
    await writeFile(path.join(dir, "calibration", "p1.yaml"), leak);
    const r = await loadProbes(dir, sc, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors).toEqual(["p1.yaml: a transcript line contains a hidden fact of client_sponsor"]);
    expect(r.errors.join(" ")).not.toMatch(/budget|ceiling/i);
    // a fact shorter than 20 characters is not checked, and the same file passes with a different scenario
    const short = good.replace("Can you confirm by Friday?", "It is too short, honestly.");
    await writeFile(path.join(dir, "calibration", "p1.yaml"), short);
    expect((await loadProbes(dir, sc, rubrics)).errors).toEqual([]);
    await writeFile(path.join(dir, "calibration", "p1.yaml"), leak);
    expect((await loadProbes(dir, scenario, rubrics)).errors).toEqual([]);
  });
  it("ignores drafts and targets.yaml", async () => {
    const { scenario, rubrics } = await ctx();
    await mkdir(path.join(dir, "calibration", "drafts"), { recursive: true });
    await writeFile(path.join(dir, "calibration", "drafts", "d.yaml"), "not a probe");
    await writeFile(path.join(dir, "calibration", "targets.yaml"), "contrastOrdering: 0.9\n");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toEqual([]);
  });
});

const mk = (id: string, criterion: string, expected: 1 | 2 | 3 | 4, split: "tune" | "holdout" = "tune"): Probe => ({
  kind: "single", id, criterion, source: "handwritten", drafter: null, approved_by: null, approved_at: null, split,
  subject: "delivery_lead", expected, transcript: [{ scene: "s1", role: "a", text: "x" }, { scene: "s1", role: "a", text: "y" }],
});

describe("lintProbeSet and assignSplit", () => {
  it("warns about a thin set, thin criteria, thin holdout and mid-heavy levels", () => {
    const w = lintProbeSet([mk("a", "discovery", 2), mk("b", "discovery", 3), mk("c", "listening", 3)]).join("\n");
    expect(w).toMatch(new RegExp(`fewer than ${MIN_SET_PROBES}`));
    expect(w).toMatch(/discovery.*fewer than 4/s);
    expect(w).toMatch(/holdout/);
    expect(w).toMatch(/level 1.*level 4|levels 1 and 4/s);
  });
  it("is a pure function of the id and total (deterministic) and splits roughly by the percentage", () => {
    expect(assignSplit("probe-1", 10)).toBe(assignSplit("probe-1", 10));
    const ids = Array.from({ length: 400 }, (_, i) => `probe-${i}`);
    const tune50 = ids.filter((id) => assignSplit(id, 10) === "tune").length;
    const tune70 = ids.filter((id) => assignSplit(id, 100) === "tune").length;
    expect(tune50).toBeGreaterThan(160); expect(tune50).toBeLessThan(240);
    expect(tune70).toBeGreaterThan(240); expect(tune70).toBeLessThan(320);
  });
});

describe("lintProbeSet balance", () => {
  const set = (counts: [number, number, number, number]): Probe[] => counts.flatMap((n, i) => Array.from({ length: n }, (_, j) => mk(`p${i + 1}-${j}`, "discovery", (i + 1) as 1 | 2 | 3 | 4)));
  const unbalanced = (ps: Probe[]) => lintProbeSet(ps).filter((w) => w.startsWith("expected levels are unbalanced"));
  it("flags a level whose share is below 15% or above 40%, naming level, counts and share", () => {
    const w = unbalanced([...set([15, 0, 0, 1])]);
    expect(w).toContain("expected levels are unbalanced: level 1 has 15 of 16 expectations (share 94%); aim for 15% to 40% per level");
    expect(w).toContain("expected levels are unbalanced: level 2 has 0 of 16 expectations (share 0%); aim for 15% to 40% per level");
    expect(w).toHaveLength(4);
  });
  it("does not flag an evenly spread set, the 15% and 40% edges, or fewer than 8 expectations", () => {
    expect(unbalanced(set([6, 6, 6, 6]))).toEqual([]);
    expect(unbalanced(set([4, 4, 4, 4]))).toEqual([]);
    expect(unbalanced(set([3, 3, 4, 0]))).toHaveLength(1);
    expect(unbalanced(set([16, 0, 0, 0]).slice(0, 7))).toEqual([]);
    // 40% and 15% exactly: 8 of 20 and 3 of 20
    expect(unbalanced(set([8, 3, 3, 6]))).toEqual([]);
    expect(unbalanced(set([9, 3, 3, 5]))).toHaveLength(1);
    expect(unbalanced(set([7, 2, 5, 6]))).toHaveLength(1);
  });
  it("counts every contrast player and ignores not_observed", () => {
    const c: Probe = { kind: "contrast", id: "c", criterion: "listening", source: "handwritten", drafter: null, approved_by: null, approved_at: null, split: "tune", players: { a: 1, b: 2, c: 3, d: 4 }, min_gap: 1, transcript: [] };
    const no = { ...mk("n", "discovery", 1), expected: "not_observed" } as Probe;
    const ps = [...set([1, 1, 1, 1]), c, c, no];
    expect(unbalanced(ps)).toEqual([]);
  });
  it("keeps the mid-heavy warning", () => {
    expect(lintProbeSet(set([0, 8, 8, 0])).join("\n")).toMatch(/mid-heavy/);
  });
});

describe("printable", () => {
  it("replaces control characters, keeps ordinary text and truncates beyond max", () => {
    expect(printable("a\u001b[2J\nb\u007fc\u009fd")).toBe("a·[2J·b·c·d");
    expect(printable("plain text")).toBe("plain text");
    expect(printable("x".repeat(100), 10)).toBe("xxxxxxxxxx…");
    expect(printable("x".repeat(80))).toBe("x".repeat(80));
    expect(printable("ab\u{1F600}cd", 3)).toBe("ab\u{1F600}…");
  });

  it("also replaces bidi controls, zero-width characters and the Unicode line and paragraph separators", () => {
    for (const c of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0xfeff]) {
      expect(printable(`a${String.fromCodePoint(c)}b`), c.toString(16)).toBe("a·b");
    }
    // neighbours of the ranges are ordinary text
    for (const c of [0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a]) expect(printable(`a${String.fromCodePoint(c)}b`), c.toString(16)).toBe(`a${String.fromCodePoint(c)}b`);
    expect(printable("é ü 日本 \u{1F600}")).toBe("é ü 日本 \u{1F600}");
  });
});
