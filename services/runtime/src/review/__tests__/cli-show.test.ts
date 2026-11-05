import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { makeDraftDir, fixedClock } from "./fixtures.js";

// Defence in depth: whatever the renderer returns, `show` strips control characters per line.
vi.mock("../view.js", async (orig) => ({
  ...(await orig<typeof import("../view.js")>()),
  renderSubjectMarkdown: () =>
    [
      "| Field | Value |",
      "| --- | --- |",
      "| Method | \u001b]0;PWNED\u0007\u001b[31mname |",
      "| Time | 00:\u009b31m12\u202e |",
      "| Key | sk-live-abcdef123456 |",
      "\tkept tab",
    ].join("\n"),
}));
import { runModerate } from "../cli.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("show output hygiene", () => {
  it("emits no control character except newline and tab, keeps the table lines, redacts secrets", async () => {
    let out = "";
    const run = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
      runModerate({
        argv,
        stdout: { write: (s) => (out += s) },
        stderr: { write: () => undefined },
        env,
        cwd: root,
        now: fixedClock(),
      });
    const rel = path.relative(root, dir);
    await run(["open", rel, "--by", "kamal"]);
    out = "";
    await run(["show", rel, "alice"], {
      OPENROUTER_API_KEY: "sk-live-abcdef123456",
    });
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(out).toContain("| Method | ]0;PWNED[31mname |");
    expect(out).toContain("\tkept tab");
    expect(out).not.toContain("sk-live");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(6);
  });
});
