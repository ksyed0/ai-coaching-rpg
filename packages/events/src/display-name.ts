export const MAX_CONSOLE_NAME_CODE_POINTS = 60;

// Controls, soft hyphen, zero-width and bidirectional characters, line and paragraph separators, word joiners and invisible
// operators, BOM, variation selectors 1-14 and tag characters: the runtime's hidden-character table, in the subset a name can carry.
// Numeric inclusive ranges, so no invisible character is ever written into this file.
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0d],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe00ff],
  [0xe01f0, 0xe0fff],
];
const isHidden = (cp: number): boolean =>
  HIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** The facilitator's name as shown to players: hidden characters removed, trimmed, cut at 60 code points. Null when nothing is left. */
export function cleanConsoleName(raw: string): string | null {
  const name = [
    ...[...raw]
      .filter((ch) => !isHidden(ch.codePointAt(0)!))
      .join("")
      .trim(),
  ]
    .slice(0, MAX_CONSOLE_NAME_CODE_POINTS)
    .join("")
    .trim();
  return name.length > 0 ? name : null;
}
