import { describe, it, expect } from 'vitest';
import { extractTlyCode } from './tly';

/**
 * The first client tests in this repo.
 *
 * extractTlyCode is where a real bug lived: our printed labels encode
 * `${clientUrl}/s/${code}`, and both scanners tested the raw payload against
 * /^TLY-/, so tally could not read its own labels. These cases are the ones
 * that were verified by hand at the time — now they run on every push.
 */
describe('extractTlyCode', () => {
  it('accepts a bare code', () => {
    expect(extractTlyCode('TLY-C-0E267B19')).toBe('TLY-C-0E267B19');
  });

  it('accepts the URL our printed labels actually encode', () => {
    expect(extractTlyCode('https://tally.example.com/s/TLY-C-0E267B19')).toBe('TLY-C-0E267B19');
  });

  it.each([
    ['lowercase', 'https://tally.example.com/s/tly-c-0e267b19'],
    ['trailing slash', 'https://tally.example.com/s/TLY-C-0E267B19/'],
    ['query string', 'https://tally.example.com/s/TLY-C-0E267B19?utm=x'],
    ['fragment', 'https://tally.example.com/s/TLY-C-0E267B19#top'],
    ['surrounding whitespace', '  TLY-C-0E267B19  '],
  ])('normalises %s', (_label, input) => {
    expect(extractTlyCode(input)).toBe('TLY-C-0E267B19');
  });

  it.each([
    ['a wifi QR', 'WIFI:S=Guest;T=WPA;P=hunter2;;'],
    ['a code buried in someone else\'s URL', 'https://evil.example.com/x?q=TLY-C-0E267B19'],
    ['an unknown entity type', 'TLY-X-0E267B19'],
    ['too many hex digits', 'TLY-C-0E267B19ZZ'],
    ['too few hex digits', 'TLY-C-0E2'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(extractTlyCode(input)).toBeNull();
  });

  it('anchors on the /s/ path so a foreign QR containing the text is not ours', () => {
    // Deliberate: matching the pattern anywhere would make a packing slip or a
    // screenshot of this app scan as a real label.
    expect(extractTlyCode('see TLY-C-0E267B19 on the box')).toBeNull();
  });

  it('accepts every entity type the label printer produces', () => {
    for (const t of ['P', 'A', 'C', 'I']) {
      expect(extractTlyCode(`TLY-${t}-0E267B19`)).toBe(`TLY-${t}-0E267B19`);
    }
  });
});
