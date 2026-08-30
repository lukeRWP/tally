// @vitest-environment jsdom
/**
 * #295: the /matches keyboard hints.
 *
 * The digit bindings (#269, see matches.resolve-keys.test.tsx) only read as
 * names if the candidate cards visibly carry the numbers they answer to —
 * per #295 and #301, arguably the highest-value hint in the whole issue,
 * since "press 2" is unguessable without it. These tests cover the numeral
 * on each CandidateCard and the `d` cap on "None of these", and the gate
 * that keeps both silent wherever the ring itself is silent: no sidebar
 * chrome, or no fine pointer even with sidebar chrome (a wide touch tablet).
 *
 * No @testing-library/jest-dom in this repo (not installed, no other test
 * uses it), so assertions read raw DOM instead of toBeInTheDocument/etc.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MatchCandidate, ProductMatch } from '@/hooks/use-matches';
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

vi.mock('@/hooks/use-matches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-matches')>();
  return {
    ...actual,
    useMatches: () => ({ data: currentRows, isLoading: false }),
    useResolveMatch: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

function candidate(n: number): MatchCandidate {
  return {
    name: `Widget ${n}`, brand: null, model: null, upc: null, priceUsd: null,
    imageUrl: null, sourceUrl: 'https://example.com/w', sourceDomain: 'example.com',
  };
}

function makeRow(id: number, candidateCount = 3): ProductMatch {
  return {
    id,
    itemId: id * 100,
    itemName: `Item ${id}`,
    containerName: 'Bin',
    status: 'ready',
    candidates: Array.from({ length: candidateCount }, (_, i) => candidate(i + 1)),
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function stubPointer(coarse: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: coarse, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderMatches(initialEntries: string[] = ['/matches?sel=1']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/matches" element={<MatchesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubPointer(false);   // fine pointer by default
  currentRows = [makeRow(1)];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('a fine pointer at a desk sees a key cap on every candidate card, in rendered order', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderMatches();

  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
});

test('"None of these" carries the d cap alongside it', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderMatches();

  // The cap is aria-hidden (it's a visual echo of the binding, not a second
  // name for the button), so the accessible name stays plain "None of these"
  // — check the cap as a sibling inside the same button instead.
  const dismiss = screen.getByRole('button', { name: 'None of these' });
  expect(within(dismiss).getByText('d')).toBeTruthy();
});

test('no caps in touch chrome, even though a mouse is attached', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderMatches();

  expect(screen.queryByText('1')).toBeNull();
  expect(screen.queryByText('2')).toBeNull();
});

test('no caps on a coarse pointer even with sidebar chrome — a wide touch tablet', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  stubPointer(true);
  renderMatches();

  expect(screen.queryByText('1')).toBeNull();
  expect(screen.queryByText('2')).toBeNull();
  expect(screen.queryByText('3')).toBeNull();
});

test('the ColHead summary hint follows the same gate', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderMatches();
  expect(screen.getByText('j k ↵')).toBeTruthy();
});

test('the ColHead summary hint is silent in touch chrome', () => {
  // No `sel` here: on phone a selected row REPLACES the list with the detail
  // panel, so the list (and its ColHead) only renders with nothing selected —
  // unlike the split-mode case above, where list and detail sit side by side.
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderMatches(['/matches']);
  expect(screen.getByText(/awaiting a product/)).toBeTruthy();
  expect(screen.queryByText('j k ↵')).toBeNull();
});
