// @vitest-environment jsdom
/**
 * Keyboard nav on /matches (#225, task-4 brief).
 *
 * Unlike search.tsx/areas.tsx — where moving the ring IS selecting — Enter is
 * a deliberate, separate step here: opening a row's panel can trigger a
 * resolve, so j/k must be free to browse past several rows without firing
 * one along the way. The design: a local ring cursor (`localHighlightIdx`)
 * drives the highlight while nothing is selected; the moment a selection
 * exists (Enter, a click, or #228's auto-advance after resolve/dismiss) the
 * ring hands off to `selectedId` as the single source of truth, via an
 * effect that reads it back. This file drives that with real keydown events.
 */
import { fireEvent, render, screen } from '@testing-library/react';
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

function renderMatches(initialEntries: string[] = ['/matches']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/matches" element={<><Probe /><MatchesPage /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The wrapping div this file's ring styling is applied to.
 *
 * `getAllByText` because a selected row's title is ALSO the detail panel's
 * heading once split — this picks the LIST row specifically (the one whose
 * text sits inside a RuledRow button), not the h2.
 */
function ringOn(text: string): boolean {
  const row = screen.getAllByText(text).find((el) => el.closest('button'));
  const wrapper = row?.closest('button')?.parentElement;
  return !!wrapper?.className.includes('ring-1');
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
  // clamps rather than moving) — not from wherever a stale local cursor
  // last sat.
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
