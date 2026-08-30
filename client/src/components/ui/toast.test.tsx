// @vitest-environment jsdom
/**
 * Pins toast placement (#265, #289) and the specific follow-up review found
 * missing: #289's own verification lived in an uncommitted local harness,
 * so a revert to top-center — or a regression in the touch offset once the
 * select-mode bar entered the picture — would have passed CI silently.
 *
 * `sonner`'s own `Toaster` is mocked here: what this component is actually
 * responsible for is computing the right `offset`/`mobileOffset` prop and
 * handing it to sonner, so that's the boundary this file asserts against
 * rather than sonner's own internal rendering (which is out of scope — a
 * third-party library's positioning math isn't this codebase's bug surface,
 * the arithmetic feeding it is).
 */
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { stackReserveCss } from '@/hooks/use-bottom-stack';
import { useBottomBarStore } from '@/store/bottom-bar-store';
import { useCarryStore } from '@/store/carry-store';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

let lastProps: { offset?: unknown; mobileOffset?: unknown } | null = null;
vi.mock('sonner', () => ({
  Toaster: (props: { offset?: unknown; mobileOffset?: unknown }) => {
    lastProps = props;
    return null;
  },
  toast: vi.fn(),
}));

// Imported AFTER the mocks above so it picks up the mocked 'sonner'.
import { Toaster } from './toast';

function resetStores() {
  useBottomBarStore.setState({ bars: {} });
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
}

/** `useCarryBannerShowing` (use-bottom-stack.ts) needs a Router context. */
function renderToaster(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Toaster />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lastProps = null;
  resetStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStores();
});

describe('desk/sidebar chrome', () => {
  beforeEach(() => { vi.mocked(useLayoutMode).mockReturnValue('sidebar'); });

  it('plain (nothing stacked): keeps sonner\'s own default centered placement', () => {
    renderToaster();
    expect(lastProps?.offset).toBeUndefined();
    expect(lastProps?.mobileOffset).toBeUndefined();
  });

  it('carrying: overrides too — at the narrower end of "sidebar" chrome (a 1180px landscape tablet) a centered toast\'s default width reaches past the carry banner\'s right-anchored panel, confirmed actually overlapping by this fix\'s own harness run', () => {
    act(() => { useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]); });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: false, carrying: true, barActive: false }) };
    expect(lastProps?.offset).toEqual(expected);
    expect(lastProps?.mobileOffset).toEqual(expected);
  });

  it('a select bar alone: overrides too — #276 made its width content-driven, so at its low (non-carrying) offset it can reach under a centered toast, also confirmed overlapping', () => {
    act(() => { useBottomBarStore.getState().register('page'); });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: false, carrying: false, barActive: true }) };
    expect(lastProps?.offset).toEqual(expected);
  });

  it('carrying AND a select bar together', () => {
    act(() => {
      useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]);
      useBottomBarStore.getState().register('page');
    });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: false, carrying: true, barActive: true }) };
    expect(lastProps?.offset).toEqual(expected);
  });
});

describe('touch chrome', () => {
  beforeEach(() => { vi.mocked(useLayoutMode).mockReturnValue('touch'); });

  it('plain (not carrying, no select bar): clears just the bottom nav', () => {
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: true, carrying: false, barActive: false }) };
    expect(lastProps?.offset).toEqual(expected);
    expect(lastProps?.mobileOffset).toEqual(expected);
  });

  it('carrying only: sits above the carry banner too', () => {
    act(() => { useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]); });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: true, carrying: true, barActive: false }) };
    expect(lastProps?.offset).toEqual(expected);
  });

  it('select bar only (a bulk action can toast without leaving select mode): sits above the bar', () => {
    act(() => { useBottomBarStore.getState().register('page'); });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: true, carrying: false, barActive: true }) };
    expect(lastProps?.offset).toEqual(expected);
  });

  it('carrying AND a select bar up together — the exact combination the follow-up review found broken (toast landing on the bar\'s own buttons)', () => {
    act(() => {
      useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]);
      useBottomBarStore.getState().register('page');
    });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: true, carrying: true, barActive: true }) };
    expect(lastProps?.offset).toEqual(expected);
    expect(lastProps?.mobileOffset).toEqual(expected);
  });

  it('the "put back" (lastMove) banner counts as carrying too, not just an active carry', () => {
    act(() => {
      useCarryStore.setState({
        lastMove: { items: [{ id: 1, name: 'Thing' }], to: { id: 2, name: 'Bin', type: 'container' } },
      });
    });
    renderToaster();
    const expected = { bottom: stackReserveCss({ touch: true, carrying: true, barActive: false }) };
    expect(lastProps?.offset).toEqual(expected);
  });

  it('on /move, carrying does NOT count — CarryBanner never renders there, so treating it as carrying would offset for a banner that isn\'t on screen (still gets the plain nav-clearance offset, not the carrying one)', () => {
    act(() => { useCarryStore.getState().pickUp([{ id: 1, name: 'Thing' }]); });
    renderToaster(['/move']);
    const expected = { bottom: stackReserveCss({ touch: true, carrying: false, barActive: false }) };
    expect(lastProps?.offset).toEqual(expected);
  });
});
