import { describe, it, expect } from 'vitest';
import { CONTAINER_TYPES, optionsWithCurrent } from './entity-form';

describe('CONTAINER_TYPES', () => {
  it('has no duplicates and nothing that would blow the VARCHAR(50) column', () => {
    expect(new Set(CONTAINER_TYPES).size).toBe(CONTAINER_TYPES.length);
    for (const t of CONTAINER_TYPES) expect(t.length).toBeLessThanOrEqual(50);
  });

  it('does not offer the system-generated "loose" type', () => {
    // findOrCreateLooseContainer (use-put-down.ts) stamps this on the synthetic
    // per-area container. It is code-owned; a user picking it by hand would
    // create something the put-down flow could later collide with.
    expect(CONTAINER_TYPES as readonly string[]).not.toContain('loose');
  });
});

describe('optionsWithCurrent', () => {
  it('returns the known list untouched when the value is already an option', () => {
    expect(optionsWithCurrent(CONTAINER_TYPES, 'Box')).toEqual(CONTAINER_TYPES);
  });

  it('preserves a value the dropdown does not know, so editing cannot drop it', () => {
    // The real case: editing the auto-created loose container.
    const opts = optionsWithCurrent(CONTAINER_TYPES, 'loose');
    expect(opts[0]).toBe('loose');
    expect(opts).toHaveLength(CONTAINER_TYPES.length + 1);
  });

  it('is case-sensitive — it never rewrites stored casing behind the user', () => {
    // 'box' and 'Box' are different strings. Silently normalising on save would
    // change a record the user only opened to edit a description.
    expect(optionsWithCurrent(CONTAINER_TYPES, 'box')[0]).toBe('box');
  });

  it('adds nothing for a create (no current value)', () => {
    for (const empty of [undefined, null, '', 0, {}]) {
      expect(optionsWithCurrent(CONTAINER_TYPES, empty)).toEqual(CONTAINER_TYPES);
    }
  });
});
