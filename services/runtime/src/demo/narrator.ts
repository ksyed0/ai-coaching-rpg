import { sanitizeText } from "../cli/render.js";

export const STEP_MS = 450;
export const ACT_MS = 700;

/** Colour only for a terminal, with NO_COLOR unset (an empty value does not count, per no-color.org) and no --no-color. */
export function shouldColor(o: { isTTY: boolean | undefined; env: NodeJS.ProcessEnv; noColor: boolean }): boolean {
  if (o.noColor) return false;
  if (o.env.NO_COLOR !== undefined && o.env.NO_COLOR !== "") return false;
  return o.isTTY === true;
}

/** The pacing delay for one narrated step. Pacing is the ONLY real waiting the runner does on purpose. */
export function paceMs(kind: "step" | "act", speed: number, fast: boolean): number {
  if (fast) return 0;
  return (kind === "act" ? ACT_MS : STEP_MS) / speed;
}

const CODES = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", cyan: "36" } as const;
export type Style = keyof typeof CODES;
/** Wraps already-sanitized text. Never call this with server text: sanitize first, then style. */
export function paint(text: string, style: Style, color: boolean): string {
  return color ? `\u001b[${CODES[style]}m${text}\u001b[0m` : text;
}

export type Narrator = ReturnType<typeof createNarrator>;

/**
 * Paced, human-readable output. Every string goes through sanitizeText (R26) BEFORE styling, so nothing a server,
 * a participant or a model wrote can put a control or escape sequence on the terminal.
 */
export function createNarrator(o: {
  write: (line: string) => void; color: boolean; speed: number; fast: boolean;
  sleep: (ms: number) => Promise<void>; signal?: AbortSignal;
  /** Receives a structured copy of every heading and technical-log line (for the Markdown transcript). Dialogue is recorded elsewhere. */
  record?: (r: { kind: "heading" | "log"; source: "system"; text: string }) => void;
}) {
  const rec = (kind: "heading" | "log", text: string) => o.record?.({ kind, source: "system", text });
  const s = sanitizeText;
  const pace = async (kind: "step" | "act") => {
    if (o.signal?.aborted) throw new Error("run aborted");
    const ms = paceMs(kind, o.speed, o.fast);
    if (ms <= 0) return;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("run aborted"));
      o.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([o.sleep(ms), aborted]); }
    finally { if (onAbort) o.signal?.removeEventListener("abort", onAbort); }
  };
  return {
    /** A section heading. */
    async act(n: number | string, title: string): Promise<void> {
      rec("heading", `ACT ${n} · ${title}`);
      o.write("");
      o.write(paint(`ACT ${s(String(n))} · ${s(title)}`, "bold", o.color));
      await pace("act");
    },
    /** One narrated step. */
    async step(text: string): Promise<void> { rec("log", text); o.write(`  ${s(text)}`); await pace("step"); },
    /** Who says what. */
    async say(who: string, text: string): Promise<void> { o.write(`  ${paint(`${s(who)}:`, "cyan", o.color)} ${s(text)}`); await pace("step"); },
    /** A scene heading, without the numbered "ACT" prefix. */
    async heading(text: string, opts: { record?: boolean } = {}): Promise<void> {
      if (opts.record !== false) rec("heading", text);
      o.write("");
      o.write(paint(s(text), "bold", o.color));
      await pace("act");
    },
    /** A line labelled with its source, e.g. "[AI character] Priya: ...". The tag is ours; `who` and `text` are sanitized. */
    async tagged(tag: string, style: Style, who: string, text: string): Promise<void> {
      o.write(`  ${paint(`[${tag}]`, style, o.color)}${who ? ` ${s(who)}:` : ""} ${s(text)}`);
      await pace("step");
    },
    async note(text: string, record = true): Promise<void> {
      if (record) rec("log", text); o.write(`  ${paint(s(text), "dim", o.color)}`); await pace("step"); },
    /** Unpaced lines, for check results. */
    ok(text: string): void { o.write(`  ${paint("✓", "green", o.color)} ${s(text)}`); },
    fail(text: string): void { o.write(`  ${paint("✗", "red", o.color)} ${s(text)}`); },
    skip(text: string): void { o.write(`  ${paint("–", "yellow", o.color)} ${s(text)}`); },
    /** A plain line (banner, summary). */
    line(text: string, record = true): void { if (record) rec("log", text); o.write(s(text)); },
    styled(text: string, style: Style): void { rec("log", text); o.write(paint(s(text), style, o.color)); },
  };
}
