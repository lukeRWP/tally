// @vitest-environment jsdom
/**
 * #284 — /matches gave no way to look at the item being identified.
 *
 * Rows arrive on this worklist BECAUSE a photo identified them, and the
 * candidate panel showed the candidates' own images but never the item's —
 * an ambiguous match forced a navigation away to /item and back just to see
 * what was being matched. `itemId` was already in the ProductMatch payload;
 * this only adds a link using it.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
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

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));

let currentRows: ProductMatch[] = [];
vi.mock('@/hooks/use-matches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-matches')>();
  return {
    ...actual,
    useMatches: () => ({ data: currentRows, isLoading: false }),
    useResolveMatch: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

function makeRow(id: number): ProductMatch {
  return {
    id,
    itemId: id * 100,
    itemName: `Item ${id}`,
    containerName: 'Bin',
    status: 'ready',
    candidates: [{
      name: 'Widget', brand: null, model: null, upc: null, priceUsd: null,
      imageUrl: null, sourceUrl: 'https://example.com/w', sourceDomain: 'example.com',
    }],
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function renderMatches(initialEntries: string[] = ['/matches']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/matches" element={<MatchesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  currentRows = [makeRow(1)];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('the candidate panel links to the item being identified, using the itemId already in the payload', () => {
  renderMatches(['/matches?sel=1']);

  const link = screen.getByRole('link', { name: /view item/i });
  expect(link.getAttribute('href')).toBe('/item/100');
});
