// @vitest-environment jsdom
/**
 * Home's search-results query (#95): a failed search rendered a blank
 * results list, indistinguishable from "nothing matched". This test locks
 * in that search now shows an error branch with Retry, matching the
 * branches recents and the properties check already had (see
 * home.search-params.test.tsx / home.keyboard-nav.test.tsx, which stub
 * `isError: false` for all three).
 *
 * Seeding the URL with `?q=` puts Home straight into the searching view on
 * mount, without needing to wait out the 300ms debounce.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { Home } from './home';

const refetchSearchMock = vi.fn();

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
    useSearchItems: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchSearchMock,
    }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, usePropertyTags: () => ({ data: [] }) };
});

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/?q=drill']}>
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
  refetchSearchMock.mockClear();
});

test('a failed search shows an error with Retry, and Retry refires the query', () => {
  renderHome();

  expect(screen.getByText("Couldn't run that search.")).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /try again/i }));
  expect(refetchSearchMock).toHaveBeenCalledTimes(1);
});
