import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isAllowedScenario, listScenarios, scenarioDir } from "../scenarios.js";

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-scen-")); dirs.push(d); return d; };

describe("listScenarios", () => {
  it("lists the shipped scenarios by folder name with their titles, sorted", async () => {
    const list = await listScenarios(REAL);
    expect(list).toEqual([
      { id: "friday-escalation", title: "The Friday Escalation" },
      { id: "friday-escalation-extended", title: "The Friday Escalation, Extended" },
    ]);
  });

  it("skips folders that do not load, files and symlinks, and a missing directory is an empty list", async () => {
    const d = tmp();
    cpSync(path.join(REAL, "friday-escalation"), path.join(d, "good"), { recursive: true });
    mkdirSync(path.join(d, "broken"));
    writeFileSync(path.join(d, "broken", "scenario.yaml"), "id: [\n");
    writeFileSync(path.join(d, "stray.txt"), "x");
    symlinkSync(path.join(d, "good"), path.join(d, "linked"));
    cpSync(path.join(REAL, "friday-escalation"), path.join(d, "has space"), { recursive: true });
    expect((await listScenarios(d)).map((s) => s.id)).toEqual(["good"]);
    expect(await listScenarios(path.join(d, "absent"))).toEqual([]);
  });

  it("reports skipped folders through the callback by folder name only", async () => {
    const d = tmp();
    mkdirSync(path.join(d, "broken"));
    const seen: string[] = [];
    await listScenarios(d, (name) => seen.push(name));
    expect(seen).toEqual(["broken"]);
  });
});

describe("allowlist", () => {
  const list = [{ id: "friday-escalation" }, { id: "b" }];
  it("matches exactly, with no trimming or case folding", () => {
    expect(isAllowedScenario(list, "friday-escalation")).toBe(true);
    expect(isAllowedScenario(list, " friday-escalation")).toBe(false);
    expect(isAllowedScenario(list, "Friday-Escalation")).toBe(false);
    expect(isAllowedScenario(list, "friday-escalation\n")).toBe(false);
    expect(isAllowedScenario(list, 5 as unknown as string)).toBe(false);
  });

  it("an id with ../ or a path separator is not allowed even if a folder exists", async () => {
    const d = tmp();
    cpSync(path.join(REAL, "friday-escalation"), path.join(d, "good"), { recursive: true });
    cpSync(path.join(REAL, "friday-escalation"), path.join(d, "outside"), { recursive: true });
    const inner = path.join(d, "scen");
    mkdirSync(inner);
    cpSync(path.join(REAL, "friday-escalation"), path.join(inner, "good"), { recursive: true });
    const real = await listScenarios(inner);
    expect(real.map((s) => s.id)).toEqual(["good"]);
    const hostile = ["../outside", "good/../good", "a/b", "a\\b", "..", ".", "", path.join(d, "outside"), "x".repeat(65), "good\0", "good/"];
    for (const id of hostile) {
      expect(isAllowedScenario(real, id)).toBe(false);
      expect(() => scenarioDir(inner, id)).toThrow();
      // even a list that wrongly contains the hostile id must not yield a path
      expect(() => scenarioDir(inner, id)).toThrow();
    }
    expect(isAllowedScenario([{ id: "../outside" }], "../outside")).toBe(false);
  });

  it("scenarioDir returns the folder only for an allowed id", async () => {
    const d = tmp();
    cpSync(path.join(REAL, "friday-escalation"), path.join(d, "good"), { recursive: true });
    expect(scenarioDir(d, "good")).toBe(path.join(d, "good"));
    expect(() => scenarioDir(d, "missing")).toThrow(/not an allowed scenario/);
  });
});
