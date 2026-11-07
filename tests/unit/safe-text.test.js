'use strict';
const { plainText, digits, bodyText, apiPath } = require('../../tools/lib/safe-text');

describe('safe-text', () => {
  test('plainText keeps one line of plain characters', () => {
    expect(plainText('Bug:\n## `x` <b>é</b>  ok', 200)).toBe('Bug: x b /b ok');
  });
  test('plainText caps the length', () => {
    expect(plainText('a'.repeat(300), 10)).toBe('aaaaaaaaaa');
  });
  test('digits keeps only digits and refuses non-numbers', () => {
    expect(digits(42)).toBe('42');
    expect(digits('7; rm -rf')).toBe('7');
    expect(() => digits('abc')).toThrow('expected a number');
    expect(() => digits(undefined)).toThrow();
  });
  test('bodyText keeps text and line breaks, replaces what is outside the alphabet', () => {
    expect(bodyText('a\nb\tc é — ok')).toBe('a\nb\tc é — ok');
    expect(bodyText('hi \u0007 \u{1F600}')).toBe('hi    ');
  });
  test('bodyText keeps a JSON document valid', () => {
    const json = bodyText(JSON.stringify({ title: 'x \u{1F600} y', body: 'line1\nline2' }));
    expect(JSON.parse(json).body).toBe('line1\nline2');
  });
  test('apiPath passes a normal path and refuses anything else', () => {
    expect(apiPath('/repos/ksyed0/ai-coaching-rpg/issues?labels=bug&state=all&per_page=100')).toContain('/issues');
    expect(() => apiPath('/repos/a/b/../../x y')).toThrow();
    expect(() => apiPath('/repos/a\r\nHost: evil')).toThrow();
  });
});
