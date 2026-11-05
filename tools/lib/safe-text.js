'use strict';

// Text that comes from outside the repository (GitHub issues) or from local files and goes to a file or to
// GitHub is rebuilt here from a fixed alphabet. Every character of the result is read from the alphabet
// string itself, never copied from the input, so the result is limited to those characters by construction.

const DIGITS = '0123456789';
const PLAIN =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?()\'"/&+_-';
// An API path: owner/name, numbers and the few query characters the sync tool builds.
const API_PATH = `${PLAIN.slice(0, 62)}/?=&-_.%`;

function range(from, to) {
  let out = '';
  for (let c = from; c <= to; c++) out += String.fromCharCode(c);
  return out;
}
// Printable ASCII, line breaks, Latin-1 and Latin Extended letters, general punctuation (dashes, quotes,
// bullets), arrows. Anything else (emoji, CJK, control characters) is replaced by a space.
const TEXT = `\n\t${range(0x20, 0x7e)}${range(0xa0, 0x24f)}${range(0x2010, 0x2027)}${range(0x2190, 0x21ff)}`;

function rebuild(input, alphabet, maxLength, fallback) {
  let out = '';
  for (const ch of String(input)) {
    if (out.length >= maxLength) break;
    const at = alphabet.indexOf(ch);
    out += at >= 0 ? alphabet[at] : fallback;
  }
  return out;
}

/** One line of plain characters, at most maxLength long: no Markdown structure, no control characters. */
function plainText(input, maxLength) {
  return rebuild(input, PLAIN, maxLength, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Digits only, at most maxLength long; throws when nothing is left (an issue number must be a number). */
function digits(input, maxLength = 12) {
  const out = rebuild(input, DIGITS, maxLength, '');
  if (out === '') throw new Error('expected a number');
  return out;
}

/** A free-text body for GitHub: line breaks and ordinary text kept, anything outside TEXT replaced by a space. */
function bodyText(input, maxLength = 60000) {
  return rebuild(input, TEXT, maxLength, ' ');
}

/** An API path: refuses (throws) when it holds a character outside API_PATH, never silently changes it. */
function apiPath(input) {
  const out = rebuild(input, API_PATH, 2048, '\u0000');
  if (out.includes('\u0000') || out !== String(input)) throw new Error('unexpected character in an API path');
  return out;
}

module.exports = { plainText, digits, bodyText, apiPath };
