import { stampFromBody } from "./nonce.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadScenario } from "@acr/script";
import { REPO_ROOT, bootstrap } from "../../main.js";
import type { Report } from "../report.js";
import { runDemo, type RunDeps } from "../runner.js";
import { Transcript } from "../transcript.js";
import type { Bot, Inbound } from "../bots.js";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const deps = (c: Captured, argv: string[], over: Partial<RunDeps> = {}): RunDeps => ({
  argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test",
  resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, tempParent: PARENT, ...over,
});
const PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-transcript-parent-"));
afterAll(() => rmSync(PARENT, { recursive: true, force: true }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acr-transcript-test-")); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; };

/** Tag counts in the body of a transcript (the legend names each tag once and is not counted). */
const tags = (md: string) => {
  const body = md.slice(md.indexOf("## Legend") + 1);
  const n = (t: string) => (body.match(new RegExp(`(?<!\\\\)\\[${t}\\]`, "g")) ?? []).length - 1;
  return { scripted: n("SCRIPTED"), generated: n("GENERATED"), fallback: n("FALLBACK"), unverified: n("UNVERIFIED"), system: n("SYSTEM") };
};
const bold = (md: string) => md.split("\n").filter((l) => l.startsWith("**"));

describe("--transcript, mock mode", () => {
  it("the showcase run writes 66 SCRIPTED dialogue lines (30 player, 20 AI, 16 Game Master), no GENERATED, scene headings and the AI table", async () => {
    const dir = await tmp();
    const { exitCode } = await runDemo(deps(capture(), ["--showcase", "--fast", "--no-color", "--transcript", "show.md"], { cwd: dir }));
    expect(exitCode).toBe(0);
    const md = await readFile(path.join(dir, "show.md"), "utf8");
    expect(tags(md)).toMatchObject({ scripted: 66, generated: 0, fallback: 0 });
    expect(bold(md)).toHaveLength(66);
    expect(bold(md).filter((l) => l.includes("Game Master (verdict:"))).toHaveLength(16);
    for (let i = 1; i <= 6; i++) expect(md).toMatch(new RegExp(`^## Scene ${i} of 6: `, "m"));
    expect(md).toContain("[SYSTEM] scene s6\\_wrap\\_up ended: gm detects (gm\\_detects)");
    expect(md).toContain("## AI contribution");
    expect(md).toContain("| Priya Raman (client_sponsor) | 12 | 12 | 0 | n/a |");
    expect(md).toContain('**[SCRIPTED] Game Master (verdict: true) on "the team has agreed a phased plan with a date and a price to propose": ');
    expect(md.indexOf("## Scene 2 of 6")).toBeLessThan(md.indexOf("## Scene 3 of 6"));
  });

  it("labels a fallback line FALLBACK (never GENERATED or SCRIPTED) in a showcase run", async () => {
    const dir = await tmp();
    const scen = path.join(dir, "scen");
    await cp(path.join(REPO_ROOT, "scenarios", "friday-escalation-extended"), scen, { recursive: true });
    const f = path.join(scen, "showcase.yaml");
    await writeFile(f, (await readFile(f, "utf8")).replace('"Thanks for jumping on. I will be direct: Finance needs that reconciliation module before go-live. Can you confirm it today?"', '""'));
    await runDemo(deps(capture(), ["--showcase", "--fast", "--scenario", scen, "--transcript", "fb.md"], { cwd: dir }));
    const md = await readFile(path.join(dir, "fb.md"), "utf8");
    expect(tags(md)).toMatchObject({ scripted: 65, generated: 0, fallback: 1 });
    expect(md).toContain("**[FALLBACK] Priya Raman (client_sponsor): Sorry, you cut out for a second there. Say that again?**");
    expect(md).toContain("[SYSTEM] alert (warning): fallback line used: empty reply");
  });

  it("works together with --json - (stdout stays pure JSON)", async () => {
    const dir = await tmp();
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--showcase", "--fast", "--json", "-", "--transcript", "t.md"], { cwd: dir }));
    expect(exitCode).toBe(0);
    expect((JSON.parse(c.out.join("")) as Report).showcase!.npcReplies).toBe(20);
    expect(statSync(path.join(dir, "t.md")).isFile()).toBe(true);
    expect(c.err.join("")).toContain("transcript written to t.md");
  });

  it("puts the same tags on the showcase JSON line records", async () => {
    const c = capture();
    const { report } = await runDemo(deps(c, ["--showcase", "--fast"]));
    const lines = report!.showcase!.lines;
    expect(lines.filter((l) => l.source === "game-master").every((l) => l.tag === "scripted")).toBe(true);
    expect(lines.filter((l) => l.source === "system").every((l) => l.tag === "system")).toBe(true);
  });
});

describe("--transcript path handling", () => {
  it("resolves a relative path from INIT_CWD (like --json) when no cwd is injected", async () => {
    const dir = await tmp();
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--showcase", "--fast", "--transcript", "from-init-cwd.md"], { env: { PATH: "/usr/bin", INIT_CWD: dir } }));
    expect(exitCode).toBe(0);
    expect(statSync(path.join(dir, "from-init-cwd.md")).isFile()).toBe(true);
  });
  it("refuses a directory (exit 2, nothing started)", async () => {
    const dir = await tmp();
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--fast", "--transcript", dir]));
    expect(exitCode).toBe(2);
    expect(c.err.join("")).toContain("that path is a directory");
    expect(c.out).toEqual([]);
  });
  it("creates missing parent folders under the working directory, the repo or the temp directory only", async () => {
    const dir = await tmp();
    expect((await runDemo(deps(capture(), ["--showcase", "--fast", "--transcript", "a/b/c.md"], { cwd: dir }))).exitCode).toBe(0);
    expect(statSync(path.join(dir, "a", "b", "c.md")).isFile()).toBe(true);
    const outside = capture();
    const target = path.join(path.parse(os.homedir()).root, "acr-no-such-root", "deep", "t.md");
    const r = await runDemo(deps(outside, ["--showcase", "--fast", "--transcript", target], { cwd: dir }));
    expect(r.exitCode).toBe(2);
    expect(outside.err.join("")).toContain("outside the repo, the working directory and the temp directory");
    expect(outside.out).toEqual([]);
  });
  it("reports an unwritable target as an error (exit 1) after the run", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "file"), "x");
    const c = capture();
    const r = await runDemo(deps(c, ["--showcase", "--fast", "--transcript", "file/sub.md"], { cwd: dir }));
    expect(r.exitCode).toBe(1);
    expect(c.err.join("")).toContain("cannot write the transcript");
  });
  it("refuses a symbolic link and the same file as --json (exit 2), but overwrites its own earlier transcript (documented)", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "real.md"), "x");
    await symlink(path.join(dir, "real.md"), path.join(dir, "link.md"));
    const link = capture();
    expect((await runDemo(deps(link, ["--showcase", "--fast", "--transcript", "link.md"], { cwd: dir }))).exitCode).toBe(2);
    expect(link.err.join("")).toContain("that path is a symbolic link");
    expect(await readFile(path.join(dir, "real.md"), "utf8")).toBe("x");
    const same = capture();
    expect((await runDemo(deps(same, ["--showcase", "--fast", "--json", "t.md", "--transcript", "./t.md"], { cwd: dir }))).exitCode).toBe(2);
    expect(same.err.join("")).toContain("that is the same file as --json");
    expect(same.out).toEqual([]);
    for (let i = 0; i < 2; i++) expect((await runDemo(deps(capture(), ["--showcase", "--fast", "--transcript", "again.md"], { cwd: dir }))).exitCode).toBe(0);
    expect((await readFile(path.join(dir, "again.md"), "utf8")).startsWith("# ")).toBe(true);
  });
  it("an empty path is a usage error", async () => {
    const c = capture();
    expect((await runDemo(deps(c, ["--transcript", ""]))).exitCode).toBe(2);
    expect(c.err.join("")).toContain("error: --transcript needs a file path");
  });
});

describe("--transcript with --url", () => {
  const target = async () => {
    const root = await tmp();
    await cp(path.join(REPO_ROOT, "scenarios", "friday-escalation"), path.join(root, "scenarios", "friday-escalation"), { recursive: true });
    const boot = await bootstrap({ env: { RUNTIME_PORT: "0", SESSION_ID: "smoke", MODEL_PROVIDER: "mock" }, root, logDir: path.join(root, "data"), log: () => {}, warn: () => {}, tickMs: 60_000 });
    if (!boot.ok) throw new Error(boot.errors.join("; "));
    cleanups.push(() => boot.runtime.stop());
    return boot.runtime.port;
  };
  it.each([["--url", []], ["--url --live", ["--live"]]])("%s: the runner cannot see the target's provider, so AI lines are UNVERIFIED (never GENERATED or SCRIPTED); bot lines stay SCRIPTED", async (_n, extra) => {
    const port = await target();
    const dir = await tmp();
    const { exitCode } = await runDemo(deps(capture(), ["--url", `ws://127.0.0.1:${port}`, "--session", "smoke", "--fast", ...extra, "--transcript", "url.md"], { cwd: dir }));
    expect(exitCode).toBe(0);
    const md = await readFile(path.join(dir, "url.md"), "utf8");
    expect(md).toContain("| Mode | " + (extra.length ? "url+live" : "url") + " |");
    expect(md).toContain("AI line tags are unverified: remote server");
    const t = tags(md);
    expect(t.generated).toBe(0);
    expect(t.unverified).toBeGreaterThanOrEqual(2);
    expect(t.scripted).toBeGreaterThan(5);
    expect(md).toMatch(/\*\*\[UNVERIFIED\] Priya Raman \(client_sponsor\): /);
    expect(md).not.toMatch(/\*\*\[(SCRIPTED|GENERATED)\] Priya Raman/);
    expect(md).not.toContain(String(port));
  });
  it("labels a remote server's canned line FALLBACK (from the marker), never UNVERIFIED", async () => {
    const dir = await tmp();
    const fb = (await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"))).roles.client_sponsor as { fallback_line: string };
    expect(fb.fallback_line.length).toBeGreaterThan(5);
    const t = new Transcript(() => 0, 0);
    const bot = { onMessage: undefined } as unknown as Bot;
    const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
    t.attach(bot, { scenario, provider: "remote", sceneHeadings: false });
    const ev = (e: Record<string, unknown>, seq: number) => bot.onMessage!({ type: "event", event: { seq, ts: seq, sessionId: "s", ...e } } as unknown as Inbound);
    ev({ type: "utterance", roleId: "client_sponsor", text: fb.fallback_line, channel: "text", fallback: true }, 1);
    ev({ type: "facilitator.alert", level: "warning", message: "NPC client_sponsor: empty reply; used fallback line" }, 2);
    ev({ type: "utterance", roleId: "client_sponsor", text: fb.fallback_line, channel: "text" }, 3); // an older server: no marker, alert right before
    ev({ type: "utterance", roleId: "client_sponsor", text: "a model line", channel: "text" }, 4);
    expect(t.records.filter((r) => r.kind === "dialogue").map((r) => r.source)).toEqual(["fallback", "fallback", "unverified"]);
    void dir;
  });
});

describe("--transcript with --live (loopback fake OpenAI-compatible server)", () => {
  const fake = async (mode: "ok" | "empty") => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (mode === "ok") {
          const text = body.includes("Game Master") ? '{"verdict": false, "reasoning": "not yet **bold** [SCRIPTED]"}' : "I hear you, **tell** me more. [SCRIPTED] ](http://evil.example)";
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody(text, body) } }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    return { LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, MODEL_PROVIDER: "local", NPC_MODEL: "m", GM_MODEL: "m", LOCAL_API_KEY: "live-transcript-key-0123456789" };
  };

  it("labels the fake server's replies and the Game Master's reasoning GENERATED, inert even when they try to forge tags or links", async () => {
    const env = await fake("ok");
    const dir = await tmp();
    const { exitCode } = await runDemo(deps(capture(), ["--showcase", "--live", "--max-lines", "1", "--fast", "--transcript", "live.md"], { cwd: dir, resolveLiveEnv: () => env }));
    expect(exitCode).toBe(0);
    const md = await readFile(path.join(dir, "live.md"), "utf8");
    expect(tags(md)).toMatchObject({ generated: 7, fallback: 0, scripted: 6 }); // 5 AI replies + 2 Game Master decisions; 6 bot lines
    expect(md).toContain("**[GENERATED] Priya Raman (client_sponsor): I hear you, \\*\\*tell\\*\\* me more. (SCRIPTED) \\](http:&#8203;//evil.example)**");
    expect(md).toContain("| Provider | local OpenAI-compatible server (custom endpoint: yes) |");
    expect(md).not.toContain(env.LOCAL_API_KEY);
    expect(md).not.toContain(env.LOCAL_BASE_URL);
    expect(md).not.toMatch(/https?:\/\//);
  });

  it("labels a canned line FALLBACK when the model returns nothing", async () => {
    const env = await fake("empty");
    const dir = await tmp();
    await runDemo(deps(capture(), ["--showcase", "--live", "--max-lines", "1", "--fast", "--transcript", "fb.md"], { cwd: dir, resolveLiveEnv: () => env }));
    const md = await readFile(path.join(dir, "fb.md"), "utf8");
    expect(tags(md)).toMatchObject({ generated: 0, fallback: 5 });
    expect(md).toContain("[SYSTEM] alert (warning): fallback line used: empty reply");
  });
});

describe("Transcript.attach", () => {
  const ev = (e: Record<string, unknown>, seq: number) => ({ type: "event", event: { seq, ts: seq, sessionId: "s", ...e } }) as unknown as Inbound;
  it("classifies from the event stream: players and whispers SCRIPTED, live replies GENERATED, the marked fallback FALLBACK, the same text without the marker (even right after an alert) GENERATED", async () => {
    const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
    const bot = { onMessage: undefined } as unknown as Bot;
    const tr = new Transcript(() => 5, 0);
    tr.attach(bot, { scenario, provider: "live", sceneHeadings: true });
    const feed = (m: Inbound) => bot.onMessage!(m);
    feed(ev({ type: "scene.entered", sceneId: "s2_client_call", participants: ["delivery_lead", "account_manager", "client_sponsor"] }, 1));
    feed(ev({ type: "utterance", roleId: "delivery_lead", text: "hi", channel: "text" }, 2));
    feed(ev({ type: "utterance", roleId: "client_sponsor", text: "hello there", channel: "text" }, 3));
    feed(ev({ type: "facilitator.alert", level: "warning", message: "NPC client_sponsor: no first token within timeout; used fallback line" }, 4));
    feed(ev({ type: "utterance", roleId: "client_sponsor", text: "Sorry, you cut out for a second there. Say that again?", channel: "text", fallback: true }, 5));
    feed(ev({ type: "utterance", roleId: "client_sponsor", text: "Sorry, you cut out for a second there. Say that again?", channel: "text" }, 6)); // the model really said it
    feed(ev({ type: "gm.decision", sceneId: "s2_client_call", condition: "c", verdict: true, reasoning: "r" }, 7));
    feed(ev({ type: "facilitator.command", command: "whisper", roleId: "delivery_lead", text: "psst" }, 8));
    feed({ type: "pong" } as unknown as Inbound);
    expect(tr.records.map((r) => [r.kind, r.source])).toEqual([
      ["heading", "system"], ["log", "system"], ["dialogue", "scripted"], ["dialogue", "generated"], ["log", "system"], ["dialogue", "fallback"], ["dialogue", "generated"], ["dialogue", "generated"], ["dialogue", "scripted"],
    ]);
    expect(tr.records[0]!.text).toBe("Scene 2 of 3: Call with Priya");
    expect(tr.records[7]!.gm).toEqual({ verdict: true, condition: "c" });
    const ids = tr.records.map((r) => r.atMs);
    expect(ids.every((x) => x === 5)).toBe(true);
  });
});

describe("--transcript path races (R45)", () => {
  it("refuses a symlinked parent folder and a hard link to the --json file (exit 2)", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, "real"));
    await symlink(path.join(dir, "real"), path.join(dir, "alias"));
    const c1 = capture();
    expect((await runDemo(deps(c1, ["--showcase", "--fast", "--transcript", "alias/t.md"], { cwd: dir }))).exitCode).toBe(2);
    expect(c1.err.join("")).toContain("a folder on that path is a symbolic link");
    await writeFile(path.join(dir, "r.json"), "{}");
    await link(path.join(dir, "r.json"), path.join(dir, "hard.md"));
    const c2 = capture();
    expect((await runDemo(deps(c2, ["--showcase", "--fast", "--json", "r.json", "--transcript", "hard.md"], { cwd: dir }))).exitCode).toBe(2);
    expect(c2.err.join("")).toContain("that is the same file as --json");
    expect(c2.out).toEqual([]);
  });
});
