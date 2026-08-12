/**
 * Tally tag codes, and how to get one out of a scanner.
 *
 * The printed form under every QR is TLY-{P|A|C|I}-{4-8 hex}. The QR itself
 * does NOT encode that — `labels.service.js` encodes `${clientUrl}/s/${code}`
 * so that pointing a phone's native camera at a label opens the app on the
 * right page. That is the right call for the paper, and it means anything
 * reading the QR's payload directly sees a URL, not a code.
 *
 * This lived as a duplicated regex in two components that each tested the raw
 * payload against ^TLY-, so both rejected our own printed labels. One
 * implementation, used by every scanner.
 */

/** A bare code, already trimmed and upper-cased. */
export const TLY_CODE_REGEX = /^TLY-[PACI]-[0-9A-F]{4,8}$/;

/**
 * Pull a tally code out of whatever a scanner decoded, or null if it isn't ours.
 *
 * Accepts the bare code and the /s/<code> deep link. Deliberately does NOT
 * search for the pattern anywhere in the payload: anchoring on the path segment
 * means an unrelated QR that happens to contain the text — a packing slip, a
 * screenshot of this app — cannot be mistaken for one of our labels.
 */
export function extractTlyCode(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (TLY_CODE_REGEX.test(s)) return s;
  const match = s.match(/\/S\/(TLY-[PACI]-[0-9A-F]{4,8})\/?(?:[?#].*)?$/);
  return match ? match[1] : null;
}
