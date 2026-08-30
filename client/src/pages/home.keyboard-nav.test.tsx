// @vitest-environment jsdom
/**
 * Keyboard nav on Home (#225, task-4 brief).
 *
 * The ring only exists over search RESULTS — recents is a browsable grid of
 * tiles/cards, not a worked list, and there is nothing there for j/k to walk.
 * `/` focuses the search input regardless of which view is showing, matching
 * search.tsx's own contract for it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { Home } from './home';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

function makeItem(over: Partial<Item> & { id: number }): Item {
  return {
    containerId: 1, productId: null, name: `Item ${over.id}`, description: null,
    quantity: 1, purchasePrice: null, currentValue: null, currentValueIsEstimate: false,
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-${over.id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as Item;
}

const results: Item[] = [
  makeItem({ id: 1, name: 'Drill' }),
  makeItem({ id: 2, name: 'Drill Bits' }),
  makeItem({ id: 3, name: 'Drill Case' }),
];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useRecentItems: () => ({ data: [makeItem({ id: 9, name: 'Recent Thing' })], isLoading: false, isError: false, refetch: vi.fn() }),
    useSearchItems: () => ({ data: results, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, usePropertyTags: () => ({ data: [] }) };
});

function ringOn(text: string): boolean {
  const el = screen.getByText(text).closest('button')?.parentElement;
  return !!el?.className.includes('ring-1');
}

function renderHome(initialEntries: string[] = ['/']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  navigateSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('j/k walks the search results, and Enter opens the highlighted item', () => {
  renderHome(['/?q=drill']);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill Bits')).toBe(true);
  expect(ringOn('Drill')).toBe(false);

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(navigateSpy).toHaveBeenCalledWith('/item/2');
});

test('Escape clears the ring', () => {
  renderHome(['/?q=drill']);
  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(true);

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(ringOn('Drill')).toBe(false);
});

test('the recents view has no ring — j is a no-op there', () => {
  renderHome(['/']);
  expect(screen.getByText('Recent Thing')).toBeTruthy();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Recent Thing')).toBe(false);
});

test('/ focuses the search input even outside a search', () => {
  renderHome(['/']);
  const input = screen.getByPlaceholderText('Search items...') as HTMLInputElement;
  expect(document.activeElement).not.toBe(input);

  fireEvent.keyDown(window, { key: '/' });
  expect(document.activeElement).toBe(input);
});

test('keys are inert while the search input itself is focused (isTyping)', () => {
  renderHome(['/?q=drill']);
  const input = screen.getByPlaceholderText('Search items...') as HTMLInputElement;
  input.focus();

  fireEvent.keyDown(input, { key: 'j' });
  expect(ringOn('Drill')).toBe(false);
  expect(ringOn('Drill Bits')).toBe(false);
});

test('the ring is off entirely on touch chrome', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderHome(['/?q=drill']);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(false);
});

// ── #270: the cursor survives the detail round-trip ──────────────────────

test('#270: a cursor in ?sel is live on arrival, and j continues from it', () => {
  // Back hands the page its history entry, params and all. Held in useState
  // the highlight was gone, and the next j re-seeded at result 1 — hundreds
  // of pixels above a correctly restored scroll position, moving nothing.
  renderHome(['/?q=drill&sel=2']);

  expect(ringOn('Drill Bits')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill Case')).toBe(true);
  expect(ringOn('Drill Bits')).toBe(false);
});

test('#270: typing a NEW query over a restored cursor drops it — nothing ringed, and Enter opens nothing', () => {
  // The two-writer bug. React Router's functional setSearchParams hands the
  // updater the params from its own render's closure, so a separate
  // sel-clearing effect and this screen's URL-sync effect, landing in the
  // same flush, both merged from the same stale snapshot — the sync effect
  // put back the `sel` the clear had just deleted. Result: `?q=hammer&sel=2`
  // with NOTHING ringed on screen and Enter opening item 2, a row from the
  // previous result set. The clear now rides the sync effect's single write.
  vi.useFakeTimers();
  try {
    renderHome(['/?q=drill&sel=2']);
    expect(ringOn('Drill Bits')).toBe(true);

    const input = screen.getByPlaceholderText('Search items...') as HTMLInputElement;
    act(() => { fireEvent.change(input, { target: { value: 'hammer' } }); });
    act(() => { vi.advanceTimersByTime(400); });   // past the 300ms debounce

    for (const name of ['Drill', 'Drill Bits', 'Drill Case']) {
      expect(ringOn(name), `${name} is still ringed after the query changed`).toBe(false);
    }

    // The invisible half: an unringed screen must not have a live cursor.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(navigateSpy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
