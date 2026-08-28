/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import source from './container-detail.tsx?raw';

/**
 * The "Scan in" button navigates to /capture with query params
 * (containerId, areaId, propertyId) for capture.tsx to pre-pin the destination.
 *
 * An earlier version incorrectly navigated to /scan, which does not read query
 * params, causing the destination to be silently discarded (GitHub issue #221).
 *
 * This test ensures the correct target is used.
 */

describe('container-detail scan-in routing', () => {
  it('navigates to /capture with query params, not /scan', () => {
    // Extract the navigate string from the "Scan in" button click handler.
    // The pattern is: navigate(`/capture?containerId=...`)
    const match = source.match(/navigate\(`(\/[a-zA-Z-]+)\?containerId=/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('/capture');
  });

  it('does not navigate to /scan for the Scan in button', () => {
    // Ensure there's no accidental /scan navigation in this component.
    // (The /capture button near line 490 also navigates, but without query params.)
    const scanMatches = [
      ...source.matchAll(/navigate\(`\/scan\?/g),
    ];
    expect(scanMatches).toHaveLength(0);
  });
});
