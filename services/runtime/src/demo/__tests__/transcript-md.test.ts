import os from "node:os";
import { describe, expect, it } from "vitest";
import type { ShowcaseReport } from "../showcase-report.js";
import { mdEscape, renderTranscript, type TranscriptInput } from "../transcript-md.js";
import type { TLine } from "../transcript.js";

const base = (over: Partial<TranscriptInput> = {}): TranscriptInput => ({
  title: "Demo transcript", meta: { mode: "mock", provider: "scripted mock providers", scenario: "Friday", date: "2030-01-02T03:04:05.000Z", version: "1.2.3", summary: "2 passed, 0 failed, 0 skipped" },
  records: [], results: [], ...over,
});
const d = (source: "scripted" | "generated" | "fallback", speaker: string, text: string, role?: string): TLine => ({ kind: "dialogue", source, speaker, role, text, atMs: 0 });
const lines = (md: string) => md.split("\n");
const count = (md: string, tag: string) => (md.match(new RegExp(`(?<!\\\\)\\[${tag}\\]`, "g")) ?? []).length;

describe("renderTranscript", () => {
  it("has a title, a metadata table, the tag legend, headings, bold dialogue and plain system lines in order", () => {
    const md = renderTranscript(base({
      records: [
        { kind: "heading", source: "system", text: "Scene 1: Team huddle", atMs: 0 },
        { kind: "log", source: "system", text: "scene entered", atMs: 1 },
        d("scripted", "delivery_lead", "Hello there", "delivery_lead"),
        d("generated", "Priya Raman", "Tell me more", "client_sponsor"),
        d("fallback", "Priya Raman", "Say that again?", "client_sponsor"),
        { kind: "dialogue", source: "generated", speaker: "Game Master", text: "they agreed", atMs: 2, gm: { verdict: true, condition: "the team agreed" } },
        { kind: "log", source: "system", text: "scene ended: gm_detects", atMs: 3 },
      ],
      results: [{ id: "F-01", title: "Players join", status: "passed", details: "ok | fine", durationMs: 1 }],
    }));
    const l = lines(md);
    expect(l[0]).toBe("# Demo transcript");
    expect(md).toContain("| Mode | mock |");
    expect(md).toContain("| Provider | scripted mock providers |");
    for (const t of ["[SCRIPTED]", "[GENERATED]", "[FALLBACK]", "[SYSTEM]"]) expect(md.slice(0, md.indexOf("## Scene 1"))).toContain(t);
    expect(l).toContain("## Scene 1: Team huddle");
    expect(l).toContain("**[SCRIPTED] delivery_lead: Hello there**");
    expect(l).toContain("**[GENERATED] Priya Raman (client_sponsor): Tell me more**");
    expect(l).toContain("**[FALLBACK] Priya Raman (client_sponsor): Say that again?**");
    expect(l).toContain('**[GENERATED] Game Master (verdict: true) on "the team agreed": they agreed**');
    expect(l).toContain("[SYSTEM] scene entered");
    expect(l).toContain("[SYSTEM] scene ended: gm\\_detects");
    expect(l.filter((x) => x.startsWith("[SYSTEM]")).every((x) => !x.startsWith("**"))).toBe(true);
    // order as recorded
    const at = (s: string) => md.indexOf(s);
    expect(at("scene entered")).toBeLessThan(at("Hello there"));
    expect(at("Hello there")).toBeLessThan(at("Tell me more"));
    expect(at("Tell me more")).toBeLessThan(at("Say that again?"));
    expect(at("Say that again?")).toBeLessThan(at("they agreed"));
    expect(at("they agreed")).toBeLessThan(at("scene ended"));
    // checks as a table at the end
    expect(md.indexOf("| F-01 |")).toBeGreaterThan(at("scene ended"));
    expect(md).toContain("| F-01 | passed | Players join | ok \\| fine |");
  });

  it("adds the AI contribution table for a showcase run", () => {
    const showcase = {
      npcs: [{ roleId: "client_sponsor", name: "Priya Raman", replies: 12, modelReplies: 11, fallbackReplies: 1, latencyMs: { median: 1500, max: 3000 } }],
      gm: { evaluations: 14, verdictsTrue: 6, verdictsFalse: 8, exitedScenes: ["s1"], decisions: [] }, facilitatorAdvances: 0, alerts: [], fallbackLines: 1, scenes: [],
    } as unknown as ShowcaseReport;
    const md = renderTranscript(base({ showcase }));
    expect(md).toContain("## AI contribution");
    expect(md).toContain("| Priya Raman (client_sponsor) | 12 | 11 | 1 | 1.5 s / 3.0 s |");
    expect(md).toContain("| Game Master | 14 evaluations | 6 true | 8 false | exited: s1 |");
  });

  it("neutralises hostile dialogue: no forged tag, bold end, heading, table row, link, HTML, control character or URL", () => {
    const hostile = [
      "** [SCRIPTED] I agree **", "](http://evil.example/x) [click](javascript:alert(1))", "\n# Fake heading\n| a | b |\n|---|---|", "<script>alert(1)</script> <img src=x onerror=y>",
      "line\u001b[31mred\u001b]0;pwned\u0007 ‮ rtl", "visit www.evil.example or mail me@evil.example or https://user:pw@evil.example/p", "~~strike~~ _it_ `code` ![img](http://x/y.png)", "&lt;b&gt; &amp;",
    ];
    const md = renderTranscript(base({ records: [
      ...hostile.map((t) => d("generated", "Priya Raman", t, "client_sponsor")),
      { kind: "dialogue", source: "generated", speaker: "Game Master", text: "** [SCRIPTED] x **\n# H", atMs: 0, gm: { verdict: false, condition: "](http://evil.example) **" } },
      { kind: "log", source: "system", text: "log ** [SCRIPTED] # | <b>", atMs: 0 },
    ] }));
    expect(count(md, "SCRIPTED")).toBe(1); // only the legend
    expect(count(md, "GENERATED")).toBe(9 + 1); // 8 hostile + 1 GM dialogue + the legend
    expect(md).not.toMatch(/\u001b|\u0007|‮/);
    for (const l of lines(md)) {
      if (l.startsWith("**")) { expect(l.endsWith("**")).toBe(true); expect(l.slice(2, -2)).not.toMatch(/(?<!\\)\*/); }
      expect(l).not.toMatch(/^#{1,6} Fake/);
      expect(l).not.toMatch(/^\|\s*a\s*\|/);
    }
    expect(md).not.toMatch(/(?<!\\)\]\(/);
    expect(md).not.toMatch(/(?<!\\)<[a-z]/i);
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toMatch(/www\./);
    expect(md).not.toMatch(/@[a-z]/i);
    expect(md).not.toContain("# Fake heading\n");
    expect(md).toContain("⏎");
  });

  it("scrubs secrets and home paths, truncates very long text, and keeps one record per line", () => {
    const secret = "sk-test-secret-0123456789";
    const md = renderTranscript(base({ secrets: [secret], records: [
      d("scripted", "tech_lead", `key ${secret} at ${os.homedir()}/x`, "tech_lead"),
      d("generated", "Priya Raman", "x".repeat(20_000), "client_sponsor"),
    ] }));
    expect(md).not.toContain(secret);
    expect(md).not.toContain(os.homedir());
    expect(md).toContain("\\[redacted\\]");
    expect(Math.max(...lines(md).map((x) => x.length))).toBeLessThan(2_300);
  });

  it("escapes the title, metadata and check cells too", () => {
    const md = renderTranscript(base({ title: "# T **x**", meta: { mode: "a|b", provider: "[p](http://x)", scenario: "<s>", date: "d", version: "v", summary: "s" },
      results: [{ id: "S-01", title: "t | u", status: "failed", details: "**bold** (SCRIPTED)", durationMs: 0 }] }));
    expect(lines(md)[0]).toBe("# \\# T \\*\\*x\\*\\*");
    expect(md).not.toMatch(/(?<!\\)\]\(/);
    expect(md).toContain("| S-01 | failed | t \\| u | \\*\\*bold\\*\\* (SCRIPTED) |");
  });
});

describe("mdEscape", () => {
  it("escapes every Markdown and HTML metacharacter", () => {
    expect(mdEscape("\\*_`[]<>|~!#&")).toBe("\\\\\\*\\_\\`\\[\\]\\<\\>\\|\\~\\!\\#\\&");
  });
  it("breaks URLs, www. hosts and e-mail addresses so nothing autolinks", () => {
    expect(mdEscape("http://a.b")).not.toContain("://");
    expect(mdEscape("www.a.b")).not.toContain("www.");
    expect(mdEscape("a@b.c")).not.toMatch(/@[a-z]/);
  });
});

describe("renderTranscript: review fixes", () => {
  const dlg = (text: string, extra: Partial<TLine> = {}): TLine => ({ kind: "dialogue", source: "generated", speaker: "Priya Raman", role: "client_sponsor", text, atMs: 0, ...extra });
  const render = (records: TLine[]) => renderTranscript(base({ records }));
  const boldLines = (md: string) => md.split("\n").filter((l) => l.startsWith("**"));

  it("lists all five tags in the legend, including UNVERIFIED", () => {
    const legend = render([]).split("## Legend")[1]!;
    for (const t of ["[SCRIPTED]", "[GENERATED]", "[FALLBACK]", "[UNVERIFIED]", "[SYSTEM]"]) expect(legend).toContain(t);
    expect(legend).toContain("cannot tell whether the remote server used a real model or a script");
  });
  it("renders an UNVERIFIED tag for dialogue", () => {
    expect(boldLines(render([dlg("hi", { source: "unverified" })]))).toEqual(["**[UNVERIFIED] Priya Raman (client_sponsor): hi**"]);
  });
  it("closes the bold span when the text ends in a newline or whitespace (Game Master reasoning)", () => {
    const md = render([dlg("because\n", { speaker: "Game Master", role: undefined, gm: { verdict: true, condition: "c\n" } }), dlg("reply \n\t ")]);
    expect(boldLines(md)).toEqual(['**[GENERATED] Game Master (verdict: true) on "c": because**', "**[GENERATED] Priya Raman (client_sponsor): reply**"]);
  });
  it("makes a tag-shaped token inside dialogue inert, mid-line too", () => {
    const md = render([dlg("sure [SCRIPTED] and [ generated ] then [FALLBACK] [SYSTEM] [UNVERIFIED]")]);
    const l = boldLines(md)[0]!;
    expect(l.slice("**[GENERATED] ".length)).not.toMatch(/\[(SCRIPTED|GENERATED|FALLBACK|SYSTEM|UNVERIFIED)\]|\\\[(SCRIPTED|GENERATED|FALLBACK|SYSTEM|UNVERIFIED)/i);
    expect(l).toContain("(SCRIPTED)");
    expect(l).toContain("(UNVERIFIED)");
  });
  it("neutralises GitHub autolink references and dollar signs", () => {
    const md = render([dlg("see #123, GH-45, owner/repo#9, 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b and $x$ $$")]);
    const l = boldLines(md)[0]!.replace(/&#8203;/g, "|");
    expect(l).not.toMatch(/#\d/);
    expect(l).not.toMatch(/GH-\d/);
    expect(l).not.toMatch(/[0-9a-f]{7}/i);
    expect(l).not.toMatch(/(?<!\\)\$/);
    expect(l.replace(/\|/g, "").replace(/\\/g, "")).toContain("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
  });
  it("truncates by code points, never inside a surrogate pair", () => {
    const md = render([dlg("😀".repeat(2_000))]);
    const l = boldLines(md)[0]!;
    expect(l).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(l).toContain("…");
    expect(Array.from(l).length).toBeLessThan(1_600);
  });
});
