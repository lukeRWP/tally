// @vitest-environment jsdom
/**
 * #284 — the carry dock's desk CTA said "Scan bin"/"Scan dest" with no
 * layout fork, even though `/move` at a desk is a destination picker, not a
 * camera, and item-detail.tsx's own Move button already forks the identical
 * sentence ("choose where it goes" / "scan where it goes") on the same
 * `useLayoutMode()` value. The banner already read the hook (for its dock
 * position); the fix reuses it for the verb too.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCarryStore } from '@/store/carry-store';
import { CarryBanner } from './carry-banner';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <CarryBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useCarryStore.setState({
    carried: [{ id: 1, name: 'Drill', kind: 'item' }],
    lastMove: null,
    pinnedDest: null,
    lastDest: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

test('on touch chrome the CTA still says Scan — the only path a phone has', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderBanner();

  expect(screen.getByRole('button', { name: /scan bin/i })).toBeTruthy();
});

test('at a desk the CTA says Choose — /move there is a picker, not a camera', () => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderBanner();

  expect(screen.getByRole('button', { name: /choose bin/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /scan bin/i })).toBeNull();
});

test('the noun still forks on kind (dest for a carried container) independent of the verb', () => {
  useCarryStore.setState({
    carried: [{ id: 1, name: 'Tote', kind: 'container' }],
    lastMove: null,
    pinnedDest: null,
    lastDest: null,
  });
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  renderBanner();

  expect(screen.getByRole('button', { name: /choose dest/i })).toBeTruthy();
});
