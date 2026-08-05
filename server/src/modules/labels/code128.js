/**
 * Minimal Code 128 (subset B) encoder.
 *
 * Written rather than pulled in as a dependency for two reasons: the CI
 * `npm audit --production` gate makes every added package a liability, and
 * drawing the bars ourselves lets the renderer snap each module to a whole
 * printer dot. At 203 dpi a barcode whose bar edges land mid-dot gets
 * resampled into ragged widths and stops scanning — the same failure mode
 * that made the QR unreadable.
 *
 * Subset B covers the full printable ASCII range, which comfortably includes
 * the TLY-{TYPE}-{HEX} code format.
 */

// Standard Code 128 bar/space width patterns, indexed by symbol value 0..106.
// Each entry is six digits: bar, space, bar, space, bar, space — except STOP,
// which carries a seventh element for its final bar.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232',
  // STOP is the one symbol with SEVEN elements (13 modules, not 11) — it ends
  // with an extra 2-module bar. Truncated to six, the symbol is short and the
  // scanner never sees a valid terminator.
  '2331112',
];

const START_B = 104;
const STOP = 106;

/**
 * Encode text as Code 128B.
 * @returns {{modules: number[], text: string}} `modules` is an alternating
 *   run-length list starting with a BAR: [barWidth, spaceWidth, barWidth, ...],
 *   each width expressed in modules (1..4).
 */
function encode(text) {
  const value = String(text);
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error(`Code128B cannot encode character ${JSON.stringify(ch)}`);
    }
  }

  const values = [START_B, ...[...value].map(ch => ch.charCodeAt(0) - 32)];

  // Checksum: start value plus each data value weighted by its 1-based
  // position, modulo 103.
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);

  const modules = [];
  for (const v of values) {
    for (const digit of PATTERNS[v]) modules.push(Number(digit));
  }
  return { modules, text: value };
}

/** Total width in modules, including the mandatory 10-module quiet zones. */
function widthInModules(text, quietZone = 10) {
  const { modules } = encode(text);
  return modules.reduce((a, b) => a + b, 0) + quietZone * 2;
}

module.exports = { encode, widthInModules };
