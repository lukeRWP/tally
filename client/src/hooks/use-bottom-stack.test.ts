// @vitest-environment jsdom
/**
 * The shared bottom-stack model (see use-bottom-stack.ts's own doc comment
 * for why it exists): one place computing the offset for every fixed-bottom
 * layer — the bottom nav, the carry banner, a page's own select-mode bar,
 * and the toast layer — instead of four independent arithmetics that can
 * silently drift apart.
 *
 * This is pure-function + store-registration logic, which jsdom expresses
 * completely honestly (unlike pixel geometry — see container-detail's own
 * select-bar test file for that distinction). The key property this file
 * pins is the one a real regression already slipped through once without
 * a committed test: that the toast layer and the content behind it are
 * ALWAYS computed by the exact same formula, so a future edit to one and
 * not the other is a diff a reviewer sees, not a mismatch a browser
 * discovers on a phone six weeks later. See toast.test.tsx for the same
 * invariant pinned at the component's own prop boundary.
 */
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, afterEach } from 'vitest';
import {
  barOffsetCss,
  barOffsetRem,
  carryBannerOffsetCss,
  stackReserveCss,
  stackReserveRem,
  toastOffsetCss,
  useBottomBarActive,
  useCarryBannerShowing,
  useRegisterBottomBar,
} from './use-bottom-stack';
import { useBottomBarStore } from '@/store/bottom-bar-store';
import { useCarryStore } from '@/store/carry-store';

function resetStores() {
  useBottomBarStore.setState({ bars: {} });
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
}

afterEach(resetStores);

describe('stackReserveRem / stackReserveCss', () => {
  it.each([
    // touch, carrying, barActive, expectedRem
    [true, false, false, 5],
    [true, true, false, 9.5],
    [true, false, true, 12],
    [true, true, true, 16.5],
    [false, false, false, 1.5],
    [false, true, false, 7],
    [false, false, true, 6],
    [false, true, true, 11.5],
  ])('touch=%s carrying=%s barActive=%s -> %irem', (touch, carrying, barActive, expected) => {
    expect(stackReserveRem({ touch, carrying, barActive })).toBe(expected);
    expect(stackReserveCss({ touch, carrying, barActive }))
      .toBe(`calc(${expected}rem + env(safe-area-inset-bottom))`);
  });

  it('is monotonic: adding a layer never REDUCES the reserve, on either chrome', () => {
    for (const touch of [true, false]) {
      const none = stackReserveRem({ touch, carrying: false, barActive: false });
      const carryOnly = stackReserveRem({ touch, carrying: true, barActive: false });
      const barOnly = stackReserveRem({ touch, carrying: false, barActive: true });
      const both = stackReserveRem({ touch, carrying: true, barActive: true });
      expect(carryOnly).toBeGreaterThan(none);
      expect(barOnly).toBeGreaterThan(none);
      expect(both).toBeGreaterThan(carryOnly);
      expect(both).toBeGreaterThan(barOnly);
    }
  });
});

describe('barOffsetRem / barOffsetCss', () => {
  it.each([
    [true, false, 5.5],
    [true, true, 10],
    [false, false, 2],
    [false, true, 7.5],
  ])('touch=%s carrying=%s -> %irem', (touch, carrying, expected) => {
    expect(barOffsetRem({ touch, carrying })).toBe(expected);
    expect(barOffsetCss({ touch, carrying }))
      .toBe(`calc(${expected}rem + env(safe-area-inset-bottom))`);
  });

  it('a bar\'s own offset never includes its own height — it always sits strictly below the reserve a bar-aware consumer would use', () => {
    // The bar itself must dock ABOVE nav+carry only; the RESERVE (what a
    // scrollable region or the toast needs) must additionally clear the
    // bar's own height. If these ever collapsed to the same number, the
    // bar would be docking on top of itself.
    for (const touch of [true, false]) {
      for (const carrying of [true, false]) {
        const barOffset = barOffsetRem({ touch, carrying });
        const reserveWithBar = stackReserveRem({ touch, carrying, barActive: true });
        expect(reserveWithBar).toBeGreaterThan(barOffset);
      }
    }
  });
});

describe('carryBannerOffsetCss', () => {
  it('touch uses the banner\'s own tuned flush-above-nav position', () => {
    expect(carryBannerOffsetCss(true)).toBe('calc(4.6rem + env(safe-area-inset-bottom))');
  });

  it('desk/sidebar matches the plain desk base every other desk consumer uses (Tailwind\'s bottom-6)', () => {
    expect(carryBannerOffsetCss(false)).toBe('calc(1.5rem + env(safe-area-inset-bottom))');
  });
});

describe('toastOffsetCss — the regression #289 follow-up guards against', () => {
  it.each([
    [true, false, false],
    [true, true, false],
    [true, false, true],
    [true, true, true],
    [false, true, false],
    [false, false, true],
    [false, true, true],
  ])('touch=%s carrying=%s barActive=%s: toast\'s offset EXACTLY equals what stackReserveCss gives the content behind it', (touch, carrying, barActive) => {
    // This is the actual bug: toast.tsx used to hardcode a single touch-only
    // constant that didn't know about the select bar and didn't know when
    // carrying was actually false — and had NO override at all on
    // desk/sidebar chrome, which this fix's own harness run found actually
    // overlapping (a centered toast against a narrow-"sidebar"-width carry
    // banner, and against the now content-driven #276 select bar). Asserting
    // exact equality with the shared reserve function — not just "close
    // enough" — is what would have caught it: a future edit that changes one
    // formula and not the other fails here immediately, in CI, rather than
    // being discovered on a phone or tablet later.
    expect(toastOffsetCss({ touch, carrying, barActive }))
      .toBe(stackReserveCss({ touch, carrying, barActive }));
  });

  it('desk/sidebar chrome with NOTHING stacked keeps sonner\'s own default (undefined) — the one case that should NOT override', () => {
    expect(toastOffsetCss({ touch: false, carrying: false, barActive: false })).toBeUndefined();
  });
});

describe('useCarryBannerShowing', () => {
  it('true for an active carry, true for a "put back" (lastMove), false for neither', () => {
    const { result, rerender } = renderHook(() => useCarryBannerShowing(), { wrapper: MemoryRouter });
    expect(result.current).toBe(false);

    act(() => { useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]); });
    rerender();
    expect(result.current).toBe(true);

    act(() => {
      useCarryStore.setState({
        carried: [],
        lastMove: { items: [{ id: 1, name: 'Thing' }], to: { id: 2, name: 'Bin', type: 'container' } },
      });
    });
    rerender();
    expect(result.current).toBe(true);

    act(() => { useCarryStore.getState().clearLastMove(); });
    rerender();
    expect(result.current).toBe(false);
  });

  it('false on /move, carrying or not — /move owns the carrying state and its own undo, so CarryBanner never renders there (and nothing should reserve clearance for it)', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ['/move'] }, children);
    const { result, rerender } = renderHook(() => useCarryBannerShowing(), { wrapper });
    expect(result.current).toBe(false);

    act(() => { useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]); });
    rerender();
    expect(result.current).toBe(false);

    act(() => {
      useCarryStore.setState({
        carried: [],
        lastMove: { items: [{ id: 1, name: 'Thing' }], to: { id: 2, name: 'Bin', type: 'container' } },
      });
    });
    rerender();
    expect(result.current).toBe(false);
  });
});

describe('useRegisterBottomBar / useBottomBarActive', () => {
  it('registers while active, unregisters on unmount', () => {
    const bar = renderHook(() => useBottomBarActive());
    expect(bar.result.current).toBe(false);

    const page = renderHook(() => useRegisterBottomBar(true));
    bar.rerender();
    expect(bar.result.current).toBe(true);

    page.unmount();
    bar.rerender();
    expect(bar.result.current).toBe(false);
  });

  it('unregisters the moment `active` flips to false, without unmounting', () => {
    const bar = renderHook(() => useBottomBarActive());
    const page = renderHook(({ active }) => useRegisterBottomBar(active), { initialProps: { active: true } });
    bar.rerender();
    expect(bar.result.current).toBe(true);

    page.rerender({ active: false });
    bar.rerender();
    expect(bar.result.current).toBe(false);
  });

  it('never registers at all if `active` starts false', () => {
    const bar = renderHook(() => useBottomBarActive());
    renderHook(() => useRegisterBottomBar(false));
    bar.rerender();
    expect(bar.result.current).toBe(false);
  });
});
