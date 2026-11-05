import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(__dirname, "../../../../..");
const RULE =
  "An agent never runs `pnpm moderate release`, `amend` or `withdraw` unless the owner explicitly names the subjects.";

describe("AC-0222: the release rule for agents is written down", () => {
  it.each(["AGENTS.md", "docs/EVALUATOR.md"])(
    "%s carries the rule",
    async (f) => {
      const text = await readFile(path.join(repo, f), "utf8");
      expect(text).toContain(RULE);
    },
  );
});
