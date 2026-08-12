/**
 * What a photo suggestion is allowed to do when it arrives.
 *
 * Extracted from capture.tsx so it can be tested. The logic is three lines and
 * has already been wrong twice — once letting a late suggestion survive a
 * catalogue hit, once with a flag read before React had run the updater that
 * set it. Both were ordering bugs, and ordering bugs are exactly what a pure
 * function makes trivial to pin down and a component makes expensive.
 *
 * The rule, in one sentence: a real record beats an inference, and a person's
 * own words beat both.
 */

export interface SuggestionContext {
  /** A barcode has resolved to a real catalogue product. */
  catalogueHit: boolean;
  /** The name in the field right now — typed, scanned, or empty. */
  currentName: string;
  /** The name the model offered, if any. */
  suggestedName: string | null;
}

export interface SuggestionDecision {
  /** Show the suggestion (name, description, category, value) at all. */
  accept: boolean;
  /** Pre-fill the name field, and mark it unconfirmed. */
  applyName: boolean;
}

export function decideSuggestion(ctx: SuggestionContext): SuggestionDecision {
  // A catalogue hit is a fact about this exact object; the photo is an
  // inference about what it looks like. This has to hold in BOTH orders —
  // clearing the guess when the barcode wins only covers the case where the
  // guess arrived first.
  if (ctx.catalogueHit) return { accept: false, applyName: false };

  // The name is the one field that lands without being asked for, so it lands
  // only into an empty box. Whitespace is not a name, but neither is it empty
  // intent — someone mid-keystroke owns the field.
  const applyName = !!ctx.suggestedName && ctx.currentName.trim() === '';
  return { accept: true, applyName };
}
