import os from "node:os";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { cleanBy } from "./text.js";
import { ReviewRefusedError } from "./errors.js";
import type { Actor } from "./types.js";
import type { Ctx } from "./cli.js";

export const facilitator = (c: Ctx): Actor => ({
  kind: "facilitator",
  by: cleanBy(c.values.by),
});
export const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new ReviewRefusedError(`unknown ${what}`);
  return v;
};
/** A file name from the directory, safe to print: hidden characters stripped, markup and secrets scrubbed, at most 64 characters. */
export const shownName = (n: string): string => {
  const t = Array.from(scrubText(stripHidden(n), []))
    .slice(0, 64)
    .join("");
  return `\`${t}${Array.from(n).length > 64 ? "..." : ""}\``;
};
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** One line of rendered Markdown made safe for a terminal; the line's own layout (tables, tabs) is kept. */
export function cleanLine(line: string, secrets: string[]): string {
  let out = stripHidden(line).replace(CONTROLS, "");
  for (const x of secrets) if (x) out = out.split(x).join("[redacted]");
  for (const [dir, label] of [
    [os.tmpdir(), "<tmp>"],
    [os.homedir(), "~"],
  ] as const)
    if (dir && dir !== "/") out = out.split(dir).join(label);
  return out;
}
