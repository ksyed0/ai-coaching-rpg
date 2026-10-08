import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CALIBRATE_USAGE, runCalibrate } from "../cli.js";
import type { Judge } from "../judge.js";
import { drafterJudge, fridayReply, scriptedDrafter, type ScriptedDrafter } from "./fake-drafter.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FRIDAY = path.join(REPO, "scenarios", "friday-escalation");
let dir: string;
let scn: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-"));
  scn = path.join(dir, "scn");
  await cp(FRIDAY, scn, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ENV = { NPC_MODEL: "gemma-4-31b" };
type Extra = { drafter?: Judge; judges?: Judge[]; now?: () => Date };
const run = async (argv: string[], extra: Extra = {}, env: NodeJS.ProcessEnv = ENV) => {
  const out: string[] = [], err: string[] = [];
  const r = await runCalibrate({ argv, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env, repoRoot: REPO, cwd: dir, ...extra });
  return { ...r, out, outText: out.join(""), errText: err.join("") };
};
const drafts = () => readdir(path.join(scn, "calibration", "drafts")).catch(() => [] as string[]);
const SPEC = ["--drafter", "drafter,qwen3-30b-a3b,http://drafter-host.example:1234/v1"];
const scripted = (f: (i: number) => string | Error = () => fridayReply()): { p: ScriptedDrafter; d: Judge } => {
  const p = scriptedDrafter((_r, i) => f(i));
  return { p, d: drafterJudge(p) };
};

describe("pnpm calibrate draft", () => {
  it("prints the planned calls first, writes the drafts, never echoes the spec's URL, and exits 0", async () => {
    const { p, d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d });
    expect(r.exitCode).toBe(0);
    expect(p.calls).toHaveLength(4);
    const planned = r.out.findIndex((l) => l.startsWith("planned: 4 drafter calls (1 criterion x 4 levels x 1 per level)"));
    const firstWritten = r.out.findIndex((l) => l.startsWith("draft draft-discovery-l1-1 written"));
    expect(planned).toBeGreaterThanOrEqual(0);
    expect(planned).toBeLessThan(firstWritten);
    expect(r.outText).toContain("drafter: drafter (qwen3-30b-a3b)");
    expect(r.outText).toMatch(/drafts written: 4 of 4/);
    expect(r.outText + r.errText).not.toContain("drafter-host");
    expect((await drafts()).sort()).toEqual([1, 2, 3, 4].map((l) => `draft-discovery-l${l}-1.yaml`));
  });
  it("makes no model call without --drafter, whatever the environment (also with MODEL_PROVIDER=mock)", async () => {
    for (const env of [ENV, { ...ENV, MODEL_PROVIDER: "mock" }, {}]) {
      const { p, d } = scripted();
      const r = await run(["draft", "--scenario", scn, "--criterion", "discovery"], { drafter: d }, env);
      expect(r.exitCode).toBe(2);
      expect(r.errText).toMatch(/^error: --drafter label,model\[,baseUrl\] is required/m);
      expect(p.calls).toHaveLength(0);
    }
    expect(await drafts()).toEqual([]);
  });
  it("refuses a drafter of the primary judge's family, and an unknown primary, unless --allow-same-family", async () => {
    const p = scriptedDrafter(() => fridayReply());
    const same = drafterJudge(p, "gemma-3-27b");
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: same });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toContain("error: the drafter's model family (gemma) is the primary judge's family (gemma)");
    const unknown = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery"], { drafter: same }, {});
    expect(unknown.exitCode).toBe(2);
    expect(unknown.errText).toMatch(/primary judge's model is not known/);
    expect(p.calls).toHaveLength(0);
    const ok = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead", "--allow-same-family"], { drafter: same });
    expect(ok.exitCode).toBe(0);
    expect(p.calls).toHaveLength(4);
  });
  it("uses EVAL_MODEL ahead of NPC_MODEL for the primary family", async () => {
    const { d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d }, { NPC_MODEL: "gemma-4-31b", EVAL_MODEL: "qwen3-235b" });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toContain("family (qwen) is the primary judge's family (qwen)");
  });
  it("exits 1 when some drafts failed after others were written, with every failure printed safely", async () => {
    const { d } = scripted((i) => (i === 1 ? "garbage \u001b[31m" : i === 2 ? new Error("down sk-SECRET-123456789") : fridayReply()));
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d }, { ...ENV, LOCAL_API_KEY: "sk-SECRET-123456789" });
    expect(r.exitCode).toBe(1);
    expect(r.errText).toMatch(/^draft draft-discovery-l2-1: the reply held no JSON object$/m);
    expect(r.errText).toMatch(/^draft draft-discovery-l3-1: the drafter failed: model error: down /m);
    expect(r.errText).not.toContain("sk-SECRET-123456789");
    // eslint-disable-next-line no-control-regex
    expect(r.errText).not.toMatch(/\u001b/);
    expect(r.outText).toMatch(/drafts written: 2 of 4/);
    expect((await drafts()).sort()).toEqual(["draft-discovery-l1-1.yaml", "draft-discovery-l4-1.yaml"]);
  });
  it("refuses bad options: per-level, a bad spec (never echoed), an option of another subcommand", async () => {
    const { p, d } = scripted();
    for (const [argv, re] of [
      [["--per-level", "4"], /--per-level must be a whole number from 1 to 3/],
      [["--per-level", "x"], /--per-level must be/],
      [["--repeat", "2"], /--repeat is not an option of draft/],
      [["--criterion", "nope"], /criterion nope is not an individual criterion/],
    ] as const) {
      const r = await run(["draft", "--scenario", scn, ...SPEC, ...argv], { drafter: d });
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.errText).toMatch(re);
    }
    const bad = await run(["draft", "--scenario", scn, "--drafter", "d,m,http://user:hunter2-pass@h:1/v1"], { drafter: d });
    expect(bad.exitCode).toBe(2);
    expect(bad.errText).toMatch(/--drafter base URL must not contain credentials/);
    expect(bad.errText).not.toContain("hunter2");
    const shape = await run(["draft", "--scenario", scn, "--drafter", "justone"], { drafter: d });
    expect(shape.errText).toMatch(/--drafter must be label,model\[,baseUrl\]/);
    expect(p.calls).toHaveLength(0);
  });
});

/** A Friday session log as JSONL: s2_client_call from seq 2; seq 3..7 are utterances. */
function logText(sponsorLine = "We need the module before go-live."): string {
  const roles = { delivery_lead: { kind: "player" }, account_manager: { kind: "player" }, tech_lead: { kind: "player" }, client_sponsor: { kind: "npc" } };
  const bodies = [
    { type: "session.started", scenarioId: "esc-scope-creep-01", version: "1", roles },
    { type: "scene.entered", sceneId: "s2_client_call", participants: ["delivery_lead", "account_manager", "client_sponsor"] },
    { type: "utterance", roleId: "client_sponsor", text: sponsorLine, channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: "What does Finance need it for?", channel: "text" },
    { type: "utterance", roleId: "client_sponsor", text: "The daily tie-out.", channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: "So the need is the daily tie-out?", channel: "text" },
    { type: "utterance", roleId: "account_manager", text: "Agreed.", channel: "text" },
  ];
  return bodies.map((b, k) => JSON.stringify({ ...b, seq: k + 1, ts: 1_800_000_000_000 + k * 1000, sessionId: "real-1" })).join("\n") + "\n";
}

describe("pnpm calibrate excerpt", () => {
  const EX = (log: string, extra: string[] = []) => ["excerpt", "--scenario", scn, "--log", log, "--from", "3", "--to", "7", "--subject", "delivery_lead", "--criterion", "discovery", "--id", "excerpt-01", ...extra];
  it("writes an excerpt draft from a session log and tells the owner what comes next", async () => {
    await writeFile(path.join(dir, "s.jsonl"), logText());
    const r = await run(EX("s.jsonl"));
    expect(r.errText).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.outText).toMatch(/excerpt draft written: calibration\/drafts\/excerpt-01\.yaml \(seq 3 to 7\)/);
    const d = parse(await readFile(path.join(scn, "calibration", "drafts", "excerpt-01.yaml"), "utf8")) as { transcript: unknown[]; source: string };
    expect(d.source).toBe("excerpt");
    expect(d.transcript).toHaveLength(5);
  });
  it("refuses a log that is not a .jsonl file, a missing or broken log, bad seq numbers and missing options, with exit 2", async () => {
    await writeFile(path.join(dir, "broken.jsonl"), "{not json\n{}\n");
    for (const [argv, re] of [
      [EX("../../../etc/passwd"), /--log must name a session log \(a \.jsonl file\)/],
      [EX("missing.jsonl"), /--log: cannot read the session log \(ENOENT\)/],
      [EX("broken.jsonl"), /--log: malformed event at line 1/],
      [EX("s.jsonl").map((a) => (a === "3" ? "x" : a)), /--from must be a whole number/],
      [EX("s.jsonl").slice(0, -2), /--id <draft id> is required/],
    ] as const) {
      const r = await run([...argv]);
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.errText).toMatch(re);
    }
    expect(await drafts()).toEqual([]);
  });
  it("refuses an excerpt with a hidden fact without printing it", async () => {
    await writeFile(path.join(dir, "s.jsonl"), logText("Between us: would accept a phased delivery after go-live if the risk is explained well."));
    const r = await run(EX("s.jsonl"));
    expect(r.exitCode).toBe(2);
    expect(r.errText).toBe("error: excerpt contains a hidden fact of client_sponsor: choose another range\n");
    expect(await drafts()).toEqual([]);
  });
});

describe("pnpm calibrate approve", () => {
  const NOW = () => new Date("2026-10-07T09:00:00.000Z");
  async function oneDraft(): Promise<void> {
    const { d } = scripted();
    expect((await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d })).exitCode).toBe(0);
  }
  it("approves a draft into calibration/, after which a run loads it; approving it again is refused", async () => {
    await oneDraft();
    const r = await run(["approve", "--scenario", scn, "--draft", "draft-discovery-l4-1", "--by", "Kamal"], { now: NOW });
    expect(r.errText).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.outText).toContain("approved: calibration/discovery-l4-1.yaml (approved by Kamal)");
    const p = parse(await readFile(path.join(scn, "calibration", "discovery-l4-1.yaml"), "utf8")) as Record<string, unknown>;
    expect(p).toMatchObject({ approved_by: "Kamal", approved_at: "2026-10-07T09:00:00.000Z", expected: 4, source: "drafted" });
    expect(await drafts()).not.toContain("draft-discovery-l4-1.yaml");
    const again = await run(["approve", "--scenario", scn, "--draft", "draft-discovery-l4-1", "--by", "Kamal"], { now: NOW });
    expect(again.exitCode).toBe(2);
    expect(again.errText).toMatch(/there is no draft draft-discovery-l4-1/);
  });
  it("refuses a missing --by, a bad --expected, a path as --draft and a hostile approver name, with exit 2", async () => {
    await oneDraft();
    for (const [argv, re] of [
      [["--draft", "draft-discovery-l1-1"], /--by <name> is required/],
      [["--draft", "draft-discovery-l1-1", "--by", "K", "--expected", "5"], /--expected must be 1, 2, 3, 4 or not_observed/],
      [["--draft", "../../scenario", "--by", "K"], /--draft must be 1 to 58 characters/],
      [["--draft", "draft-discovery-l1-1", "--by", "evil\u001b]0;x\u0007"], /--by must be 1 to 120 printable characters/],
    ] as const) {
      const r = await run(["approve", "--scenario", scn, ...argv], { now: NOW });
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.errText).toMatch(re);
      // eslint-disable-next-line no-control-regex
      expect(r.errText).not.toMatch(/[\u0007\u001b]/);
    }
    expect((await drafts()).length).toBe(4);
  });
});

describe("pnpm calibrate assign-splits", () => {
  it("adds missing splits, reports each file, and exits 1 when a file could not be changed", async () => {
    const cal = path.join(scn, "calibration");
    const disc = await readFile(path.join(cal, "disc-l1.yaml"), "utf8");
    await writeFile(path.join(cal, "nosplit.yaml"), disc.replace("id: disc-l1", "id: nosplit").replace("split: tune\n", ""));
    const ok = await run(["assign-splits", "--scenario", scn]);
    expect(ok.exitCode).toBe(0);
    expect(ok.outText).toContain("split added: calibration/nosplit.yaml");
    expect(ok.outText).toContain("1 file changed");
    await writeFile(path.join(cal, "broken.yaml"), "a: [\n");
    const bad = await run(["assign-splits", "--scenario", scn]);
    expect(bad.exitCode).toBe(1);
    expect(bad.errText).toMatch(/^not changed: broken\.yaml: /m);
  });
});

/** Permission tests need a non-root user: root ignores directory modes. */
const ROOT = process.getuid?.() === 0;

describe("pnpm calibrate: authoring exit codes and output hygiene", () => {
  const NOW = () => new Date("2026-10-07T09:00:00.000Z");
  const calDrafts = () => path.join(scn, "calibration", "drafts");
  async function oneDraft(): Promise<void> {
    const { d } = scripted();
    expect((await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d })).exitCode).toBe(0);
  }
  it.skipIf(ROOT)("approve exits 1 when the probe was written but the draft could not be deleted (as --help promises)", async () => {
    expect(CALIBRATE_USAGE.replace(/\s+/g, " ")).toContain("approve: the draft could not be deleted");
    await oneDraft();
    await chmod(calDrafts(), 0o500);
    try {
      const r = await run(["approve", "--scenario", scn, "--draft", "draft-discovery-l3-1", "--by", "Kamal"], { now: NOW });
      expect(r.exitCode).toBe(1);
      expect(r.outText).toContain("approved: calibration/discovery-l3-1.yaml");
      expect(r.errText).toContain("error: the probe was written but the draft calibration/drafts/draft-discovery-l3-1.yaml could not be deleted: delete it by hand");
    } finally { await chmod(calDrafts(), 0o700); }
    expect(await drafts()).toContain("draft-discovery-l3-1.yaml");
  });
  it.skipIf(ROOT)("exits 1 (not 2) on an unexpected failure while writing, naming only the error code", async () => {
    await writeFile(path.join(dir, "s.jsonl"), logText());
    await mkdir(calDrafts(), { recursive: true });
    await chmod(calDrafts(), 0o500);
    try {
      const r = await run(["excerpt", "--scenario", scn, "--log", "s.jsonl", "--from", "3", "--to", "7", "--subject", "delivery_lead", "--criterion", "discovery", "--id", "excerpt-01"]);
      expect(r.exitCode).toBe(1);
      expect(r.errText).toBe("error: excerpt failed: EACCES\n");
    } finally { await chmod(calDrafts(), 0o700); }
  });
  it("approve reads --expected not_observed, and warns about other probe problems but still approves", async () => {
    await writeFile(path.join(dir, "s.jsonl"), logText());
    expect((await run(["excerpt", "--scenario", scn, "--log", "s.jsonl", "--from", "3", "--to", "7", "--subject", "delivery_lead", "--criterion", "discovery", "--id", "excerpt-01"])).exitCode).toBe(0);
    await writeFile(path.join(scn, "calibration", "broken.yaml"), "kind: [\n");
    const r = await run(["approve", "--scenario", scn, "--draft", "excerpt-01", "--by", "Kamal", "--expected", "not_observed"], { now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.outText).toContain("warning: 1 probe problem in calibration/ (run pnpm calibrate to list them); approving anyway");
    expect(parse(await readFile(path.join(scn, "calibration", "excerpt-01.yaml"), "utf8"))).toMatchObject({ expected: "not_observed" });
  });
  it("makes stdout and stderr of the authoring commands printable and scrubs secrets (file names are untrusted)", async () => {
    const SECRET = "sk-SECRET-123456789";
    const cal = path.join(scn, "calibration");
    const disc = await readFile(path.join(cal, "disc-l1.yaml"), "utf8");
    await writeFile(path.join(cal, `evil\u001b[2J-${SECRET}.yaml`), disc.replace("id: disc-l1", "id: evil-one").replace("split: tune\n", ""));
    await writeFile(path.join(cal, `bad\u001b]0;x\u0007-${SECRET}.yaml`), "a: [\n");
    const r = await run(["assign-splits", "--scenario", scn], {}, { ...ENV, LOCAL_API_KEY: SECRET });
    expect(r.exitCode).toBe(1);
    expect(r.outText).toMatch(/^split added: calibration\/evil·\[2J-/m);
    expect(r.errText).toMatch(/^not changed: bad·\]0;x·-/m);
    for (const t of [r.outText, r.errText]) {
      expect(t).not.toContain(SECRET);
      // eslint-disable-next-line no-control-regex
      expect(t).not.toMatch(/[\u0007\u001b]/);
    }
  });
});

describe("R29: draft input checked before the planned-calls line; approve checks its directories", () => {
  /** The scenario copy with criterion `discovery` renamed to `id` (rubric and scenario). */
  const renameDiscovery = async (id: string) => {
    for (const f of [path.join(scn, "rubrics", "individual_delivery_v2.yaml"), path.join(scn, "scenario.yaml")]) {
      await writeFile(f, (await readFile(f, "utf8")).replace(/\bdiscovery\b/g, id));
    }
    await rm(path.join(scn, "calibration"), { recursive: true, force: true });
  };
  it("refuses an unknown --subject with exit 2, before the planned line and any call", async () => {
    const { p, d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "nobody"], { drafter: d });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toMatch(/subject nobody is not a player role/);
    expect(r.outText).not.toContain("planned:");
    expect(p.calls).toHaveLength(0);
  });
  it.each([["--criterion"], ["(every criterion)"]])("refuses a criterion id over 47 characters (%s) with exit 2, before the planned line", async (how) => {
    const long = "d".repeat(48);
    await renameDiscovery(long);
    const { p, d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, ...(how === "--criterion" ? ["--criterion", long] : []), "--subject", "delivery_lead"], { drafter: d });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toContain(`criterion ${long} is too long for a draft id (at most 47 characters)`);
    expect(r.outText).not.toContain("planned:");
    expect(p.calls).toHaveLength(0);
  });
  it("accepts a criterion id of exactly 47 characters (draft id of 58)", async () => {
    const id47 = "d".repeat(47);
    await renameDiscovery(id47);
    const { p, d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", id47, "--subject", "delivery_lead"], { drafter: d });
    expect(r.errText).not.toContain("too long");
    expect(r.outText).toContain("planned: 4 drafter calls");
    expect(p.calls).toHaveLength(4);
  });
  it("sends EVAL_MAX_TOKENS as the drafter's token budget", async () => {
    const { p, d } = scripted();
    const r = await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d }, { ...ENV, EVAL_MAX_TOKENS: "1234" });
    expect(r.exitCode).toBe(0);
    expect(p.calls.map((c) => c.maxTokens)).toEqual([1234, 1234, 1234, 1234]);
  });
  it("approve exits 2 for a calibration/drafts that is a symbolic link, and keeps the draft behind it", async () => {
    const { d } = scripted();
    expect((await run(["draft", "--scenario", scn, ...SPEC, "--criterion", "discovery", "--subject", "delivery_lead"], { drafter: d })).exitCode).toBe(0);
    const real = path.join(scn, "calibration", "drafts");
    const elsewhere = path.join(dir, "elsewhere");
    await rename(real, elsewhere);
    await symlink(elsewhere, real);
    const r = await run(["approve", "--scenario", scn, "--draft", "draft-discovery-l2-1", "--by", "Kamal"]);
    expect(r.exitCode).toBe(2);
    expect(r.errText).toMatch(/calibration\/drafts must be a directory, not a symbolic link or a file/);
    expect(await readdir(elsewhere)).toContain("draft-discovery-l2-1.yaml");
    expect(await readdir(path.join(scn, "calibration"))).not.toContain("discovery-l2-1.yaml");
  });
});
