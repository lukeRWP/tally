// @vitest-environment jsdom
/**
 * #274 — Home's results use the desk they are shown on.
 *
 * Home was the one browse surface in the app whose list had no wide treatment,
 * and it is the app's default surface: fifty 1100px-wide rows at 1440, while
 * `/search` — a page most people never reach, because `/` on Home refocuses
 * Home's own field — had a split view with a live preview pane.
 *
 * Contract under test:
 *   (a) at a desk, Home's results render beside the preview pane;
 *   (b) clicking a result at a desk SELECTS it (writes the one `?sel` cursor
 *       the ring already uses) instead of navigating away;
 *   (c) on touch nothing changes — no pane, and a row still opens the item;
 *   (d) a tally code pasted into Home's box goes where the code points, the
 *       one hard capability `/search` had and Home did not.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-000${over.id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as Item;
}

const results: Item[] = [
  makeItem({ id: 1, name: 'Drill' }),
  makeItem({ id: 2, name: 'Drill Bits' }),
];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useRecentItems: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
    useSearchItems: () => ({ data: results, isLoading: false, isError: false, refetch: vi.fn() }),
    // The preview pane fetches the selected item for real otherwise.
    useItem: (id: number) => ({
      data: id ? { ...makeItem({ id, name: `Item ${id}` }), location: { area: 'Garage', container: 'Bin 3' } } : undefined,
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
  navigateSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('(a) at a desk the results sit beside a preview pane, which prompts before anything is picked', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderHome(['/?q=drill']);

  expect(screen.getByText('Drill')).toBeTruthy();
  expect(screen.getByText('Pick a result to see where it lives.')).toBeTruthy();
});

test('(b) clicking a result at a desk selects it into the pane — the cursor is ?sel, and the page does not navigate', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderHome(['/?q=drill']);

  fireEvent.click(screen.getByText('Drill Bits'));

  // One writer, one cursor: the same `?sel` param j/k moves (#270/#293).
  expect(screen.getByTestId('url').textContent).toContain('sel=2');
  expect(navigateSpy).not.toHaveBeenCalled();
  // The pane now answers "where does it live" without a page load.
  expect(screen.getByText('Garage › Bin 3')).toBeTruthy();
});

test('(c) on touch there is no pane, and a row still opens the item', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderHome(['/?q=drill']);

  expect(screen.queryByText('Pick a result to see where it lives.')).toBeNull();

  fireEvent.click(screen.getByText('Drill Bits'));
  expect(navigateSpy).toHaveBeenCalledWith('/item/2');
});

test('(d) a tally code pasted into Home goes where the code points, instead of matching nothing', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderHome(['/']);

  fireEvent.change(screen.getByPlaceholderText('Search items...'), {
    target: { value: 'TLY-I-0004AB' },
  });

  fireEvent.click(screen.getByText('Go to TLY-I-0004AB'));
  expect(navigateSpy).toHaveBeenCalledWith('/s/TLY-I-0004AB');
});
