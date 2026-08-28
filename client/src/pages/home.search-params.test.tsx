// @vitest-environment jsdom
/**
 * Home's search state lives in the URL so Back from a result restores the
 * search instead of dumping the user at the recents view (#224).
 *
 * Contract under test (task-5 brief):
 *   (a) typing (debounced) writes `q` to the URL, and does it with `replace`
 *       — Back must leave Home, never rewind through one keystroke at a time.
 *   (b) mounting with `?q=drill&tags=1,2&status=lent` hydrates all four
 *       search-state pieces (searchInput/searchQuery + both filters) and
 *       shows the searching view, not recents.
 *   (c) the sync effect MERGES rather than rebuilds — a pre-existing
 *       unrelated param survives a query change.
 *
 * `useProperties`/`useRecentItems`/`useSearchItems`/`usePropertyTags` are
 * stubbed so the test exercises real URL wiring without a network. One
 * property (id 1) carries two tags (ids 1 and 2) so hydrating
 * `selectedTagIds` from `?tags=1,2` is visible as rendered tag chips, not
 * just internal state.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
    useSearchItems: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return {
    ...actual,
    usePropertyTags: (propertyId: number) => ({
      data: propertyId === 1
        ? [
          { id: 1, name: 'Fragile', color: '#ff0000', propertyId: 1 },
          { id: 2, name: 'Electronics', color: '#00ff00', propertyId: 1 },
        ]
        : [],
    }),
  };
});

/** Exposes the current URL and last navigation type alongside Home. */
function HomeWithLocationProbe() {
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <>
      <div data-testid="url">{location.pathname + location.search}</div>
      <div data-testid="navtype">{navType}</div>
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
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('(a) typing writes the debounced query to the URL as a replace, not a push', () => {
  vi.useFakeTimers();
  renderHome();

  const input = screen.getByPlaceholderText('Search items...');
  act(() => {
    fireEvent.change(input, { target: { value: 'drill' } });
  });

  // Not yet — the debounce hasn't settled.
  expect(screen.getByTestId('url').textContent).toBe('/');

  act(() => {
    vi.advanceTimersByTime(300);
  });

  expect(screen.getByTestId('url').textContent).toBe('/?q=drill');
  expect(screen.getByTestId('navtype').textContent).toBe('REPLACE');
});

test('(b) mounting with ?q=drill&tags=1,2&status=lent hydrates all four states and shows the searching view', () => {
  renderHome(['/?q=drill&tags=1,2&status=lent']);

  // searchInput hydrated — the box shows the query, not empty over results.
  expect((screen.getByPlaceholderText('Search items...') as HTMLInputElement).value).toBe('drill');

  // searchQuery hydrated too (not just the input) — the searching view shows
  // immediately, with no need to wait out the debounce.
  expect(screen.getByText(/^Results/)).toBeTruthy();
  expect(screen.queryByText(/^Recently added/)).toBeNull();

  // Filters hydrated: opening the panel shows the Lent status active and the
  // two tag chips selected — proof selectedStatus and selectedTagIds both
  // came from the URL, not just internal counters.
  fireEvent.click(screen.getByLabelText('Toggle filters'));
  expect(screen.getByRole('button', { name: 'Lent' }).className.split(' ')).toContain('bg-[var(--color-primary)]');
  expect(screen.getByText('Fragile')).toBeTruthy();
  expect(screen.getByText('Electronics')).toBeTruthy();
});

test('(c) the sync effect merges — a pre-existing unrelated param survives a query change', () => {
  vi.useFakeTimers();
  renderHome(['/?foo=bar']);

  expect(screen.getByTestId('url').textContent).toBe('/?foo=bar');

  const input = screen.getByPlaceholderText('Search items...');
  act(() => {
    fireEvent.change(input, { target: { value: 'lamp' } });
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });

  const url = screen.getByTestId('url').textContent ?? '';
  expect(url).toContain('foo=bar');
  expect(url).toContain('q=lamp');
});
