// @vitest-environment jsdom
/**
 * Keyboard nav on Home (#225, task-4 brief).
 *
 * The ring only exists over search RESULTS — recents is a browsable grid of
 * tiles/cards, not a worked list, and there is nothing there for j/k to walk.
 * `/` focuses the search input regardless of which view is showing, matching
 * search.tsx's own contract for it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
