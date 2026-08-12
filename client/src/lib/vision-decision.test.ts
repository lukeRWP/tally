import { describe, it, expect } from 'vitest';
import { decideSuggestion } from './vision-decision';

const ctx = (over: Partial<Parameters<typeof decideSuggestion>[0]> = {}) =>
  decideSuggestion({ catalogueHit: false, currentName: '', suggestedName: 'White Mug', ...over });

describe('decideSuggestion', () => {
  it('accepts and applies into an empty field', () => {
    expect(ctx()).toEqual({ accept: true, applyName: true });
  });

  it('never overwrites a name the user typed', () => {
    expect(ctx({ currentName: 'Dad’s mug' })).toEqual({ accept: true, applyName: false });
  });

  it('never overwrites a name a barcode produced', () => {
    // The lookup sets the name and marks a catalogue hit; the suggestion may
    // still be in flight at that point.
    expect(ctx({ catalogueHit: true, currentName: 'DeWalt 20V Impact Driver' }))
      .toEqual({ accept: false, applyName: false });
  });

  it('discards a late suggestion after a catalogue hit, even with an empty name', () => {
    // The regression from #169: a barcode matched, vision was cleared, then the
    // response landed and put the panel back. A real record beats an inference
    // whichever order they arrive in.
    expect(ctx({ catalogueHit: true, currentName: '' }))
      .toEqual({ accept: false, applyName: false });
  });

  it('accepts the suggestion when the barcode found nothing', () => {
    // Half the household is in no catalogue. That is the case this feature
    // exists for, and it must not be confused with a hit.
    expect(ctx({ catalogueHit: false, currentName: '' }))
      .toEqual({ accept: true, applyName: true });
  });

  it('treats whitespace as an empty field', () => {
    expect(ctx({ currentName: '   ' })).toEqual({ accept: true, applyName: true });
  });

  it('still accepts a suggestion that offers no name', () => {
    // A description or category alone is worth showing; there is just nothing
    // to pre-fill.
    expect(ctx({ suggestedName: null })).toEqual({ accept: true, applyName: false });
  });

  it('is pure — the same input always decides the same way', () => {
    const input = { catalogueHit: false, currentName: '', suggestedName: 'Mug' };
    expect(decideSuggestion(input)).toEqual(decideSuggestion(input));
    expect(input).toEqual({ catalogueHit: false, currentName: '', suggestedName: 'Mug' });
  });
});
