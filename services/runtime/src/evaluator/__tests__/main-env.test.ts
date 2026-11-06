import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveEvaluatorEnv } from "../env.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acr-evenv-"));
  await writeFile(path.join(root, ".env"), "ONLY_IN_DOTENV=secret\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("evaluator env resolution", () => {
  it("evaluator main does not read the repo .env when NO_DOTENV=1 (a key placed in a temp .env is absent from the resolved env)", () => {
    const env = resolveEvaluatorEnv(root, { NO_DOTENV: "1", A: "b" });
    expect(env.ONLY_IN_DOTENV).toBeUndefined();
    expect(env.A).toBe("b");
  });
  it("still reads the repo .env when NO_DOTENV is unset", () => {
    expect(resolveEvaluatorEnv(root, {}).ONLY_IN_DOTENV).toBe("secret");
  });
});
