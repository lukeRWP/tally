import { describe, it, expect } from 'vitest';
import { asList } from './list';

/**
 * The point is not tidiness — it is that a page must not be destroyed by a
 * response shape. Every value here has been seen from a real API at some point:
 * an object where a list was promised, a null, an error body that parsed.
 */
describe('asList', () => {
  it('passes arrays straight through, same reference', () => {
    const xs = [1, 2, 3];
    expect(asList<number>(xs)).toBe(xs);
  });

  it('turns everything that is not an array into an empty list', () => {
    for (const bad of [undefined, null, {}, { items: [] }, 0, '', 'abc', true, NaN]) {
      expect(asList(bad), `${JSON.stringify(bad)} should degrade, not throw`).toEqual([]);
    }
  });

  it('never throws, whatever it is handed', () => {
    // A keydown target, a Proxy, a Date — render code should not have to care.
    for (const weird of [new Date(), Symbol('x'), () => {}, new Map()]) {
      expect(() => asList(weird as unknown)).not.toThrow();
    }
  });

  it('is safe to call on the result of a failed request', () => {
    // TanStack Query hands back undefined while loading and on error; the page
    // still renders its empty state rather than blanking.
    expect(asList(undefined)).toEqual([]);
    expect(asList(undefined).map((x) => x)).toEqual([]);
  });
});
