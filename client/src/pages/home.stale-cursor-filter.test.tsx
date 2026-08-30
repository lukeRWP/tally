// @vitest-environment jsdom
/**
 * #307 — a filter change leaves a stale `?sel` cursor, and since #304's desk
 * preview pane, that now renders a full preview of an item that is no longer
 * in the result set.
 *
 * `home.tsx`'s URL-sync effect used to clear `?sel` only when `searchQuery`
 * changed. Narrowing the tag/condition/status filters after clicking a
 * result never touched `searchQuery`, so `?sel` survived pointing at a row
 * the new, narrower result set no longer contains — and `ItemPreview` fetches
 * by id with no cross-check against the visible list, so it rendered that
 * item in full.
 *
 * Contract under test:
 *   (a) selecting a result, then narrowing the STATUS filter to a set that
 *       excludes it, clears `?sel` from the URL;
 *   (b) the preview pane falls back to the empty-state prompt instead of
 *       continuing to show the item that fell out of the list.
 *
 * `useSearchItems` is mocked to actually respond to the `status` filter (most
 * other Home tests stub it with one static array) so the result set visibly
 * changes when the Lent pill is clicked.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { Home } from './home';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

function makeItem(over: Partial<Item> & { id: number }): Item {
  return {
    containerId: 1, productId: null, name: `Item ${over.id}`, description: null,
    quantity: 1, purchasePrice: null, currentValue: null, currentValueIsEstimate: false,
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-000${over.id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as Item;
}

const drill = makeItem({ id: 1, name: 'Drill' });
const drillBits = makeItem({ id: 2, name: 'Drill Bits' });
const allResults: Item[] = [drill, drillBits];
// Narrowing to Lent drops id 2 — the row `?sel` will point at — out of the
// result set entirely. This is the reported shape: the filter, not the
// query, is what stops matching the selected row.
const lentResults: Item[] = [drill];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useRecentItems: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
    // Filter-aware: returns the full set for the default 'all' status, and a
    // set that EXCLUDES id 2 (the row `?sel` will point at) once narrowed to
    // 'lent' — mirroring "narrowing a filter drops the selected row".
    useSearchItems: (_query: string, filters?: { status?: string }) => ({
      data: filters?.status === 'lent' ? lentResults : allResults,
      isLoading: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
    }),
    // The preview pane fetches the selected item for real otherwise — it has
    // no idea whether id 2 is still in the visible list, which is exactly
    // the gap #307 is about.
    useItem: (id: number) => ({
      data: id
        ? { ...makeItem({ id, name: `Item ${id}` }), location: { area: 'Garage', container: 'Bin 3' } }
        : undefined,
      isLoading: false,
    }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, usePropertyTags: () => ({ data: [] }) };
});

function HomeWithLocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="url">{location.pathname + location.search}</div>
      <Home />
    </>
  );
}

function renderHome(initialEntries: string[] = ['/']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/" element={<HomeWithLocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('(a) narrowing the status filter clears a ?sel that no longer matches the result set', () => {
  renderHome(['/?q=drill&sel=2']);

  // Sanity: id 2 is in the unfiltered set, so the preview renders it.
  expect(screen.getByText('Garage › Bin 3')).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toContain('sel=2');

  // Narrow to Lent — item 2 falls out of the result set.
  fireEvent.click(screen.getByLabelText('Toggle filters'));
  fireEvent.click(screen.getByRole('button', { name: 'Lent' }));

  expect(screen.getByTestId('url').textContent).not.toContain('sel=2');
  expect(screen.getByTestId('url').textContent).not.toMatch(/[?&]sel=/);
});

test('(b) the preview pane falls back to the empty prompt instead of a stale full preview', () => {
  renderHome(['/?q=drill&sel=2']);

  expect(screen.getByText('Garage › Bin 3')).toBeTruthy();

  fireEvent.click(screen.getByLabelText('Toggle filters'));
  fireEvent.click(screen.getByRole('button', { name: 'Lent' }));

  // The stale item's own preview (its location line) is gone…
  expect(screen.queryByText('Garage › Bin 3')).toBeNull();
  // …replaced by the same empty-state prompt an unvisited page shows.
  expect(screen.getByText('Pick a result to see where it lives.')).toBeTruthy();
});
