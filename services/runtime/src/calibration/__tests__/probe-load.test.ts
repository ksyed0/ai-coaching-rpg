import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    await writeFile(path.join(cal, "proto.yaml"), good.replace("id: p1", "id: proto") + "__proto__: { polluted: 1 }\n");
    // the same probe files without the hostile part load cleanly, so only the defences can refuse them
    await writeFile(path.join(cal, "ok.yaml"), good.replace("id: p1", "id: ok"));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes.map((p) => p.id)).toEqual(["ok"]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.find((e) => e.startsWith("big.yaml:"))).toMatch(/larger than/);
    expect(r.errors.find((e) => e.startsWith("bomb.yaml:"))).toMatch(/alias/i);
    expect(r.errors.find((e) => e.startsWith("proto.yaml:"))).toMatch(/prototype key/);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
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
    expect(r2.errors[0]).toMatch(/\(\+\d+ more\)$/);
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
    await writeFile(path.join(cal, "k.yaml"), good.replace("id: p1", "id: k") + `"${evil}${"z".repeat(300)}": 1\n`);
    const r = await loadProbes(dir, scenario, rubrics);
    const lines = [...r.errors, ...r.warnings];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(l).not.toContain("\u001b");
      expect(l).not.toContain("\n");
      expect(l.length).toBeLessThan(400);
    }
    expect(r.errors.some((e) => e.startsWith("k.yaml:"))).toBe(true);
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

describe("printable", () => {
  it("replaces control characters, keeps ordinary text and truncates beyond max", () => {
    expect(printable("a\u001b[2J\nb\u007fc\u009fd")).toBe("a·[2J·b·c·d");
    expect(printable("plain text")).toBe("plain text");
    expect(printable("x".repeat(100), 10)).toBe("xxxxxxxxxx…");
    expect(printable("x".repeat(80))).toBe("x".repeat(80));
    expect(printable("ab\u{1F600}cd", 3)).toBe("ab\u{1F600}…");
  });
});
