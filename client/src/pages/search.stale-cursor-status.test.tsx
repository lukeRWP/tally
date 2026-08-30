// @vitest-environment jsdom
/**
 * #307 — `/search` has the identical gap Home had: narrowing the STATUS chip
 * can leave `?sel` pointing at a row the new result set no longer contains,
 * and since #304's desk split view, `ItemPreview` fetches by id with no
 * cross-check against the visible list — so it renders that row in full
 * rather than nothing.
 *
 * Unlike home.tsx, this page had NO `sel`-clearing at all before this fix —
 * `sel` was written only by `select()` (a click or keyboard move) and never
 * revalidated against the settled query or status. The fix folds a `sel`
 * clear into the existing query/status URL-sync effect (the page's one
 * `setSearchParams` writer for that merge) rather than adding a second
 * effect — see that effect's comment for why a second writer in the same
 * commit is unsafe.
 *
 * Contract under test:
 *   (a) selecting a result, then narrowing the status chip to one that
 *       excludes it, clears `?sel` from the URL;
 *   (b) the preview pane falls back to the empty-state prompt instead of
 *       continuing to show the item that fell out of the list.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { SearchPage } from './search';

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
// result set entirely, mirroring the reported shape.
const lentResults: Item[] = [drill];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
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

function SearchWithLocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="url">{location.pathname + location.search}</div>
      <SearchPage />
    </>
  );
}

function renderSearch(initialEntries: string[] = ['/search']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/search" element={<SearchWithLocationProbe />} />
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

test('(a) narrowing the status chip clears a ?sel that no longer matches the result set', () => {
  renderSearch(['/search?q=drill&sel=2']);

  // Sanity: id 2 is in the unfiltered set, so the preview renders it.
  expect(screen.getByText('Garage › Bin 3')).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toContain('sel=2');

  fireEvent.click(screen.getByRole('button', { name: 'Lent' }));

  expect(screen.getByTestId('url').textContent).not.toContain('sel=2');
  expect(screen.getByTestId('url').textContent).not.toMatch(/[?&]sel=/);
});

test('(b) the preview pane falls back to the empty prompt instead of a stale full preview', () => {
  renderSearch(['/search?q=drill&sel=2']);

  expect(screen.getByText('Garage › Bin 3')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Lent' }));

  // The stale item's own preview (its location line) is gone…
  expect(screen.queryByText('Garage › Bin 3')).toBeNull();
  // …replaced by the same empty-state prompt an unvisited page shows.
  expect(screen.getByText('Pick a result to see where it lives.')).toBeTruthy();
});
