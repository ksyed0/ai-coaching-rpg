import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// US-0072 (EPIC-0003 voice A1c, Task 7, plan K13): pnpm resolves a built-in command before a script of the same name, so
// `pnpm --filter @acr/voice-ops up` would run `pnpm update` and rewrite package.json and the lockfile. Every root voice:* script must
// therefore say `run`, and no voice-ops script may carry a built-in's name.

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const scriptsOf = (file: string): Record<string, string> => (JSON.parse(readFileSync(file, "utf8")) as { scripts: Record<string, string> }).scripts;

/**
 * pnpm 9.15.9's commands and aliases, from `pnpm help` (and the commands it documents elsewhere: dlx, create, env, ...). The
 * script-running built-ins `run`, `start`, `test` and `t` run a script of that name, so they are harmless as script names.
 */
const PNPM_BUILTINS = [
  "add", "import", "i", "install", "it", "install-test", "ln", "link", "prune", "rb", "rebuild", "rm", "remove", "uninstall", "un",
  "unlink", "up", "update", "upgrade", "audit", "licenses", "ls", "list", "la", "ll", "outdated", "exec", "cat-file", "cat-index",
  "find-hash", "pack", "publish", "root", "store", "dlx", "create", "env", "setup", "server", "deploy", "patch", "patch-commit",
  "patch-remove", "config", "c", "get", "set", "init", "why", "doctor", "fetch", "bin", "dedupe", "self-update", "recursive", "multi",
  "m", "help", "completion", "install-completion", "ignored-builds", "approve-builds", "cache", "outdated", "sbom", "version", "login",
  "logout", "whoami", "owner", "dist-tag", "unpublish", "deprecate", "undeprecate", "search", "view", "info", "show", "ping", "docs",
  "home", "bugs", "repo", "issues", "rebuild", "add", "prefix", "hook",
];

describe("the root voice scripts (K13)", () => {
  it("every voice:* root script names run, and exactly the four exist", () => {
    const root = scriptsOf(path.join(REPO_ROOT, "package.json"));
    const voice = Object.keys(root).filter((k) => k.startsWith("voice:")).sort();
    expect(voice).toEqual(["voice:check", "voice:down", "voice:timings", "voice:up"]);
    for (const k of voice) expect(root[k]).toBe(`pnpm -s --filter @acr/voice-ops run voice-${k.slice("voice:".length)}`);
  });

  it("no @acr/voice-ops script is named like a pnpm built-in", () => {
    const own = scriptsOf(path.join(PACKAGE_DIR, "package.json"));
    for (const name of Object.keys(own)) expect(PNPM_BUILTINS).not.toContain(name);
    for (const cmd of ["up", "down", "check", "timings"]) expect(own[`voice-${cmd}`]).toBe(`node --import tsx src/cli.ts ${cmd}`);
  });
});
