// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCoarsePointer, COARSE_QUERY } from './use-coarse-pointer';

function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    get matches() { return matches; },
    media: COARSE_QUERY,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    flip(next: boolean) { matches = next; listeners.forEach((fn) => fn({ matches: next })); },
    listenerCount: () => listeners.size,
  };
}

describe('useCoarsePointer', () => {
  it('reads the primary pointer on first render, no flash', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
  });

  it('tracks change events (keyboard docked onto a convertible)', () => {
    const mq = mockMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    act(() => mq.flip(false));
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const mq = mockMatchMedia(false);
    const { unmount } = renderHook(() => useCoarsePointer());
    expect(mq.listenerCount()).toBe(1);
    unmount();
    expect(mq.listenerCount()).toBe(0);
  });
});
