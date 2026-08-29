// @vitest-environment jsdom
/**
 * #238 — a search query change (retyping, flipping a filter) flashed the
 * loading skeleton and briefly shrank the results list to whatever the new
 * page happened to be (often empty), which clamped the shared scroll
 * container (root-layout's `<main>`, see use-scroll-restoration.ts) back to
 * the top.
 *
 * The fix lives in `useSearchItems` itself (`placeholderData:
 * keepPreviousData`) — shared by Home and search.tsx — so `useSearchItems`
 * is deliberately NOT mocked here. This drives it for real through a real
 * QueryClient against a controlled `api.get`, keyed by the `q` param, so a
 * slow second query can be held open while asserting on what's on screen.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Item } from '@/types/inventory';
import { Home } from './home';

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecentItems: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
    // useSearchItems intentionally left as `actual` — it's the fix under test.
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, usePropertyTags: () => ({ data: [] }) };
});

// vi.mock factories are hoisted above ordinary top-level declarations, so
// the mock and the state it closes over are built together via vi.hoisted —
// referencing a plain `const` here would hit it before initialization.
const { getMock, pending } = vi.hoisted(() => {
  // One array of pending resolvers per `q` value the search hook has requested.
  const pendingMap: Record<string, Array<(v: unknown) => void>> = {};
  const get = (path: string) => new Promise((resolve) => {
    const q = new URL(path, 'http://test.local').searchParams.get('q') ?? '';
    (pendingMap[q] ??= []).push(resolve);
  });
  return { getMock: get, pending: pendingMap };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock as unknown as typeof actual.api.get },
  };
});

function resolveQuery(q: string, items: Item[]) {
  const resolvers = pending[q] ?? [];
  delete pending[q];
  resolvers.forEach((resolve) => resolve({ items }));
}

function makeItem(id: number, name: string): Item {
  return {
    id, containerId: 1, productId: null, name, description: null, quantity: 1,
    purchasePrice: null, currentValue: null, currentValueIsEstimate: false,
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-${id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z',
  };
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
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  for (const key of Object.keys(pending)) delete pending[key];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('retyping the query keeps the previous results on screen (no skeleton, no empty-state flash) while the new one loads', async () => {
  const { container } = renderHome(['/?q=drill']);

  // First query settles with two results.
  await waitFor(() => expect(pending.drill?.length).toBe(1));
  act(() => resolveQuery('drill', [makeItem(1, 'Cordless Drill'), makeItem(2, 'Drill Bit Set')]));
  await screen.findByText('Cordless Drill');
  expect(screen.getByText('Drill Bit Set')).toBeTruthy();
  expect(screen.getByText('Results · 2')).toBeTruthy();

  // Retype — a new query key, deliberately left unresolved so the in-flight
  // window can be inspected.
  vi.useFakeTimers();
  const input = screen.getByPlaceholderText('Search items...');
  act(() => fireEvent.change(input, { target: { value: 'drills' } }));
  act(() => vi.advanceTimersByTime(300));
  vi.useRealTimers();

  await waitFor(() => expect(pending.drills?.length).toBe(1));

  // The OLD results are still fully on screen — no skeleton, no gap, no
  // premature "Nothing matched" for the new query text — while the new
  // request is in flight.
  expect(screen.getByText('Cordless Drill')).toBeTruthy();
  expect(screen.getByText('Drill Bit Set')).toBeTruthy();
  expect(screen.getByText('Results · 2')).toBeTruthy();
  expect(container.querySelectorAll('.animate-pulse').length).toBe(0);
  expect(screen.queryByText('Nothing matched')).toBeNull();

  // Settle the new query with zero matches — only now should the old rows
  // disappear and the real empty-state (naming the CURRENT query) render.
  act(() => resolveQuery('drills', []));
  await waitFor(() => expect(screen.getByText('Nothing matched')).toBeTruthy());
  expect(screen.getByText(/No items for “drills”/)).toBeTruthy();
  expect(screen.queryByText('Cordless Drill')).toBeNull();
});
