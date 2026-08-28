// @vitest-environment jsdom
/**
 * Keyboard nav on /matches (#225, task-4 brief; fix round 1 per task-4-review.md).
 *
 * Unlike search.tsx/areas.tsx — where moving the ring IS selecting — Enter is
 * a deliberate, separate step here: opening a row's panel can trigger a
 * resolve, so j/k must be free to browse past several rows without firing
 * one along the way. The cursor is tracked BY ID (`highlightedId`), not by
 * index: an index re-derived from `ids` identity would snap back to the
 * selected row on every 5s poll (M1 — any status flip anywhere gives `rows`
 * a new array identity even when its CONTENT is unchanged), silently undoing
 * the very browsing this split exists to protect. It syncs from `selectedId`
 * only when `selectedId` itself changes (a click, Enter, or #228's
 * auto-advance) — that's the hand-off to the single source of truth — and
 * separately reconciles only when the highlighted ROW ITSELF disappears
 * (falls back to the still-selected row, else the first remaining row, else
 * nothing — which also closes L6, the ghost ring after the last resolve).
 * L2: the selected/open row and the browsing cursor now carry visually
 * distinct, independent classes, so browsing away never makes the open row
 * disappear from the list.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProductMatch } from '@/hooks/use-matches';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { MatchesPage } from './matches';

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

let currentRows: ProductMatch[] = [];
const mutateMock = vi.fn();

vi.mock('@/hooks/use-matches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-matches')>();
  return {
    ...actual,
    useMatches: () => ({ data: currentRows, isLoading: false }),
    useResolveMatch: () => ({ mutate: mutateMock, mutateAsync: vi.fn(), isPending: false }),
  };
});

function makeRow(id: number, status: ProductMatch['status'] = 'ready'): ProductMatch {
  return {
    id,
    itemId: id * 100,
    itemName: `Item ${id}`,
    containerName: 'Bin',
    status,
    candidates: status === 'ready'
      ? [{
        name: 'Widget', brand: null, model: null, upc: null, priceUsd: null,
        imageUrl: null, sourceUrl: 'https://example.com/w', sourceDomain: 'example.com',
      }]
      : [],
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="url">{location.pathname + location.search}</div>;
}

function matchesTree() {
  return (
    <Routes>
      <Route path="/matches" element={<><Probe /><MatchesPage /></>} />
    </Routes>
  );
}

function renderMatches(initialEntries: string[] = ['/matches']) {
  return render(<MemoryRouter initialEntries={initialEntries}>{matchesTree()}</MemoryRouter>);
}

/**
 * The wrapping div this file's ring styling is applied to.
 *
 * `getAllByText` because a selected row's title is ALSO the detail panel's
 * heading once split — this picks the LIST row specifically (the one whose
 * text sits inside a RuledRow button), not the h2.
 */
function rowWrapper(text: string): HTMLElement | undefined {
  const row = screen.getAllByText(text).find((el) => el.closest('button'));
  return row?.closest('button')?.parentElement ?? undefined;
}

/** The browsing cursor (L2: independent of `selectedOn`). */
function ringOn(text: string): boolean {
  return !!rowWrapper(text)?.className.includes('ring-1');
}

/** The persistent "this row is open" marker (L2: independent of `ringOn`). */
function selectedOn(text: string): boolean {
  return !!rowWrapper(text)?.className.includes('bg-[var(--color-elevated)]');
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  vi.mocked(useLayoutMode).mockReturnValue('sidebar'); // split view — the ring only shows here
  currentRows = [makeRow(1), makeRow(2), makeRow(3)];
  mutateMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('j walks the ring through visible order without selecting (Enter is the separate commit step)', () => {
  renderMatches();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Item 1')).toBe(true);
  // Not selected yet — movement alone never opens the panel here.
  expect(screen.getByTestId('url').textContent).toBe('/matches');

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Item 2')).toBe(true);
  expect(ringOn('Item 1')).toBe(false);
  expect(screen.getByTestId('url').textContent).toBe('/matches');
});

test('Enter selects the highlighted row', () => {
  renderMatches();
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' }); // row 2 highlighted
  fireEvent.keyDown(window, { key: 'Enter' });

  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=2');
});

test('a programmatic selection (a click, or #228\'s auto-advance) moves the ring too — selectedId is the single source of truth once set', () => {
  renderMatches(['/matches?sel=1']);

  // Nothing pressed yet, but row 1 is already selected via the URL — the
  // ring must show it without any keypress, proving it derives from
  // selectedId rather than requiring j/k to have visited it first.
  expect(ringOn('Item 1')).toBe(true);

  // Clicking a row calls select() the exact same way #228's auto-advance
  // does after a resolve/dismiss succeeds — neither goes through j/k.
  fireEvent.click(screen.getByText('Item 3'));
  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=3');
  expect(ringOn('Item 3')).toBe(true);
  expect(ringOn('Item 1')).toBe(false);

  // And the ring now picks up from THERE (row 3 is the last of 3, so j
  // clamps rather than moving) — not from wherever a stale cursor last sat.
  fireEvent.keyDown(window, { key: 'j' });
  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=3'); // movement alone still doesn't select
  expect(ringOn('Item 3')).toBe(true);

  fireEvent.keyDown(window, { key: 'k' });
  expect(ringOn('Item 2')).toBe(true);
  expect(ringOn('Item 3')).toBe(false);
});

test('Escape clears the selection AND the ring', () => {
  renderMatches(['/matches?sel=2']);
  expect(ringOn('Item 2')).toBe(true);

  fireEvent.keyDown(window, { key: 'Escape' });

  expect(screen.getByTestId('url').textContent).toBe('/matches');
  expect(ringOn('Item 2')).toBe(false);
});

test('keys are inert while an unrelated field is focused (isTyping)', () => {
  renderMatches();
  const stray = document.createElement('input');
  document.body.appendChild(stray);
  stray.focus();

  fireEvent.keyDown(stray, { key: 'j' });

  expect(ringOn('Item 1')).toBe(false);
  expect(screen.getByTestId('url').textContent).toBe('/matches');

  document.body.removeChild(stray);
});

test('the ring is off entirely on touch chrome (non-split)', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderMatches();

  fireEvent.keyDown(window, { key: 'j' });

  expect(ringOn('Item 1')).toBe(false);
});

// ── Fix round 1: M1, L2, L6 ──────────────────────────────────────────────

test('M1: a poll refetch (new array identity, same rows) leaves a mid-browse cursor in place', () => {
  const { rerender } = renderMatches(['/matches?sel=1']);

  // Cursor starts on the selection (row 1), then browses two rows away
  // WITHOUT selecting them (Enter never pressed) — sel stays row 1.
  fireEvent.keyDown(window, { key: 'j' }); // row 2
  fireEvent.keyDown(window, { key: 'j' }); // row 3
  expect(ringOn('Item 3')).toBe(true);
  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=1');

  // Simulate the 5s poll: brand new array AND row objects, identical ids —
  // exactly what a background refetch with no real change produces.
  currentRows = [makeRow(1), makeRow(2), makeRow(3)];
  rerender(<MemoryRouter initialEntries={['/matches?sel=1']}>{matchesTree()}</MemoryRouter>);

  // The cursor must still be on row 3 — not snapped back to the selection.
  expect(ringOn('Item 3')).toBe(true);
  expect(ringOn('Item 1')).toBe(false);
});

test('L2: the selected (open) row keeps a persistent marker distinct from the browsing cursor', () => {
  renderMatches(['/matches?sel=1']);
  expect(selectedOn('Item 1')).toBe(true);
  expect(ringOn('Item 1')).toBe(true); // cursor starts on the selection too

  // Browse the cursor away to row 3 without selecting it.
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' });

  // Row 1 (still selected/open, panel showing its candidates) keeps its
  // marker even though the cursor has moved off it.
  expect(selectedOn('Item 1')).toBe(true);
  expect(ringOn('Item 1')).toBe(false);
  // Row 3 (cursor) gets the ring but is not marked as the open row.
  expect(ringOn('Item 3')).toBe(true);
  expect(selectedOn('Item 3')).toBe(false);
});

test('L6: resolving the last actionable row never leaves a ghost ring — lands on a real remaining row', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'none')];
  const { rerender } = renderMatches(['/matches?sel=1']);
  expect(ringOn('Item 1')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
  const [, opts] = mutateMock.mock.calls[0];
  // Row 2 is 'none', not 'ready' — nextPendingAfter has nowhere to advance to.
  await act(async () => { opts.onSuccess({ product: null, duplicates: [] }); });
  expect(screen.getByTestId('url').textContent).toBe('/matches');

  // The resolved row is gone from the data, as a real refetch would reflect.
  currentRows = [makeRow(2, 'none')];
  rerender(<MemoryRouter initialEntries={['/matches?sel=1']}>{matchesTree()}</MemoryRouter>);

  expect(screen.queryByText('Item 1')).toBeNull();
  // Landed on the real remaining row, not stuck on the vanished one.
  expect(ringOn('Item 2')).toBe(true);
});

test('L6 (no rows left): the cursor ends up null, not pointing at nothing', async () => {
  currentRows = [makeRow(1, 'ready')];
  const { rerender } = renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
  const [, opts] = mutateMock.mock.calls[0];
  await act(async () => { opts.onSuccess({ product: null, duplicates: [] }); });
  expect(screen.getByTestId('url').textContent).toBe('/matches');

  currentRows = [];
  rerender(<MemoryRouter initialEntries={['/matches?sel=1']}>{matchesTree()}</MemoryRouter>);

  // Nothing left to render, and nothing throws reconciling a cursor against
  // an empty list — the empty state renders instead of the list/detail.
  expect(screen.getByText('Nothing waiting')).toBeTruthy();
});
