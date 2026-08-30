// @vitest-environment jsdom
/**
 * #284 — the roll-preset cluster on a staged row did not line up down the
 * list: an item row renders 2 presets (2×1/3×3 — `large` is a manifest and
 * is never offered for an item), a container/area row renders 3, and the
 * cluster sat right up against the fixed remove `X`. Omitting the 4×6 button
 * on item rows shifted the VISIBLE buttons' x-position by a roll's width
 * whenever a row's entityType differed from its neighbour's.
 *
 * Fix: reserve an invisible, disabled, aria-hidden 4×6 slot on an item row
 * instead of omitting it — the cluster's width (and so its alignment) stays
 * the same on every row, item or bin, while the slot stays inert and
 * invisible to both sight and assistive tech.
 *
 * Uses the same store-seeding pattern as print-queue.batch.test.tsx.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { usePrintQueueStore } from '@/store/print-queue-store';
import type { StagedLabel } from '@/store/print-queue-store';
import type { Printer, PrintJob } from '@/hooks/use-print';
import { useBottomBarStore } from '@/store/bottom-bar-store';
import { PrintQueuePage } from './print-queue';

function renderPage() {
  return render(
    <MemoryRouter>
      <PrintQueuePage />
    </MemoryRouter>,
  );
}

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));

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

vi.mock('@/hooks/use-print', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-print')>();
  return {
    ...actual,
    // No printer at all — the "Loaded roll" picker (which also renders a
    // real 2×1/3×3/4×6 trio) does not render, so every ROLLS button on
    // screen belongs to a staged row.
    usePrinters: () => ({ data: [] as Printer[], isLoading: false, isError: false }),
    usePrintJobs: () => ({ data: [] as PrintJob[] }),
    useCreatePrintJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCancelPrintJob: () => ({ mutate: vi.fn(), isPending: false }),
    useRetryPrintJob: () => ({ mutate: vi.fn(), isPending: false }),
    useSetLoadedMedia: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function label(over: Partial<StagedLabel> & { id: number; name: string }): StagedLabel {
  return {
    key: `${over.entityType ?? 'item'}:${over.id}`, entityType: 'item', qrCode: `TLY-I-${over.id}`,
    propertyId: 1, preset: 'small', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrintQueueStore.setState({ staged: [] });
  useBottomBarStore.setState({ bars: {} });
});

afterEach(() => {
  usePrintQueueStore.setState({ staged: [] });
  useBottomBarStore.setState({ bars: {} });
});

test('an item row reserves an invisible, disabled 4×6 slot instead of omitting it', () => {
  usePrintQueueStore.setState({ staged: [label({ id: 1, name: 'Widget', entityType: 'item' })] });
  renderPage();

  // Present in the DOM (reserves layout width)…
  const allFourBySix = screen.getAllByText('4×6');
  expect(allFourBySix.length).toBe(1);
  const placeholder = allFourBySix[0].closest('button') as HTMLButtonElement;
  expect(placeholder).toBeTruthy();

  // …but invisible and out of both the accessibility tree and the tab order.
  expect(placeholder.className.split(' ')).toContain('invisible');
  expect(placeholder.getAttribute('aria-hidden')).toBe('true');
  expect(placeholder.disabled).toBe(true);
  expect(placeholder.getAttribute('tabindex')).toBe('-1');

  // The real, clickable presets for an item are still exactly 2×1 and 3×3.
  expect(screen.getByRole('button', { name: '2×1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '3×3' })).toBeTruthy();
  // A screen reader (respecting aria-hidden) sees no 4×6 button at all.
  expect(screen.queryByRole('button', { name: '4×6' })).toBeNull();
});

test('a container row keeps a real, clickable 4×6 button — same width, no placeholder needed', () => {
  usePrintQueueStore.setState({
    staged: [label({ id: 2, name: 'Bin', entityType: 'container', preset: 'medium' })],
  });
  renderPage();

  const button = screen.getByRole('button', { name: '4×6' });
  expect(button.className.split(' ')).not.toContain('invisible');
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

test('a mixed batch keeps the same cluster width on every row — one 4×6 node per row either way', () => {
  usePrintQueueStore.setState({
    staged: [
      label({ id: 1, name: 'Widget', entityType: 'item' }),
      label({ id: 2, name: 'Bin', entityType: 'container', preset: 'medium' }),
    ],
  });
  renderPage();

  // Two-or-more staged rows also renders the "Set all to" bulk bar, which
  // contributes its own real 4×6 (the batch is not all-item) — so the total
  // is 3: bulk (real) + item row (hidden placeholder) + container row
  // (real). The point under test is the per-row split: one 4×6 DOM node on
  // EVERY row regardless of entityType, so the cluster's width never varies
  // row to row.
  expect(screen.getAllByText('4×6').length).toBe(3);
  expect(screen.getAllByRole('button', { name: '4×6' }).length).toBe(2);
});
