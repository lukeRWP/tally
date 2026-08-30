// @vitest-environment jsdom
/**
 * Keyboard nav on the container detail page (#225, task-4 brief).
 *
 * One ring over the VISIBLE order: nested-bin cards THEN item rows, exactly
 * as rendered — Enter navigates to whichever kind is highlighted. Off while
 * the batch-select checkboxes are up ("Select" mode), since Enter jumping to
 * a whole other page would fight that flow.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { ContainerDetail } from './container-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

function makeContainer(over: Partial<Container> & { id: number }): Container {
  return {
    areaId: 5, parentContainerId: null, name: `Bin ${over.id}`, type: 'box',
    description: null, qrCode: `TLY-C-${over.id}`, containerCount: 0, itemCount: 0,
    breadcrumb: [], ...over,
  } as Container;
}

function makeItem(over: Partial<Item> & { id: number }): Item {
  return {
    containerId: 1, productId: null, name: `Item ${over.id}`, description: null,
    quantity: 1, purchasePrice: null, currentValue: null, currentValueIsEstimate: false,
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-${over.id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as Item;
}

const container = makeContainer({ id: 1, name: 'The Bin', containerCount: 2, itemCount: 2 });
const children: Container[] = [
  makeContainer({ id: 10, name: 'Nested A' }),
  makeContainer({ id: 11, name: 'Nested B' }),
];
const items: Item[] = [
  makeItem({ id: 20, name: 'Item A' }),
  makeItem({ id: 21, name: 'Item B' }),
];

// Mutable so the reconciliation test below can simulate a bulk delete (#231)
// shrinking the list mid-visit — same pattern as matches.keyboard-nav.test.tsx.
// currentChildren mirrors it so the #235 grid-order test can render enough
// bins to fill more than one grid row.
let currentItems: Item[] = items;
let currentChildren: Container[] = children;

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({ data: currentChildren, isLoading: false }),
    useItems: () => ({ data: currentItems, isLoading: false }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

// Bulk delete/tag (#231) added a useAddTag() call to the page — stub it the
// same way the hooks above are stubbed, so this file doesn't need a real
// QueryClientProvider just because the component now imports one more hook.
vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, useAddTag: () => ({ mutateAsync: vi.fn(), isPending: false }) };
});

/** The div this file's ring styling is applied to, one level above the row's own button. */
function ringOn(text: string): boolean {
  const el = screen.getByText(text).closest('button')?.parentElement;
  return !!el?.className.includes('ring-1');
}

function renderPage(entry = '/container/1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/container/:containerId" element={<ContainerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  navigateSpy.mockClear();
  currentItems = items;
  currentChildren = children;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('j walks bins THEN items, in rendered order', () => {
  renderPage();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested B')).toBe(true);
  expect(ringOn('Nested A')).toBe(false);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Item A')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Item B')).toBe(true);

  fireEvent.keyDown(window, { key: 'k' });
  expect(ringOn('Item A')).toBe(true);
});

test('Enter navigates to the highlighted container or item', () => {
  renderPage();

  fireEvent.keyDown(window, { key: 'j' }); // Nested A
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(navigateSpy).toHaveBeenCalledWith('/container/10');

  navigateSpy.mockClear();
  fireEvent.keyDown(window, { key: 'j' }); // Nested B
  fireEvent.keyDown(window, { key: 'j' }); // Item A
  fireEvent.keyDown(window, { key: 'j' }); // Item B
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(navigateSpy).toHaveBeenCalledWith('/item/21');
});

test('Escape clears the ring', () => {
  renderPage();
  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(true);

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(ringOn('Nested A')).toBe(false);
});

test('keys are inert while an unrelated field is focused (isTyping)', () => {
  renderPage();
  const stray = document.createElement('input');
  document.body.appendChild(stray);
  stray.focus();

  fireEvent.keyDown(stray, { key: 'j' });
  expect(ringOn('Nested A')).toBe(false);

  document.body.removeChild(stray);
});

test('#279: in select mode the ring still MOVES, and Enter ticks the row instead of navigating', () => {
  // The old contract switched the whole ring off here, which took j/k down
  // with Enter while leaving the highlight painted — a cursor that looked
  // live and answered nothing. Only Enter's meaning changes now: it must not
  // navigate away mid-selection, so it toggles the highlighted row instead,
  // which is what makes "tick 12 scattered rows" a keyboard job.
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(true);
  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested B')).toBe(true);

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(navigateSpy).not.toHaveBeenCalled();
  // The bulk bar counts what Enter ticked.
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(navigateSpy).not.toHaveBeenCalled();
});

test('#279: the ring goes quiet while one of this page\'s own dialogs is open', () => {
  // Dropping the `!selecting` gate above removed something it was covering by
  // accident: bulk delete/tag only open IN select mode, so the ring used to
  // be off under them. Enter belongs to the dialog's buttons while one is up,
  // and `/` must not navigate the page out from under it.
  renderPage('/container/1?nav=container:10');
  expect(ringOn('Nested A')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(screen.getByText('1 selected')).toBeTruthy();

  // Scoped to the select-mode action bar — the page's own Delete is a
  // separate control with the same label.
  const bulkBar = screen.getByText('1 selected').parentElement!;
  fireEvent.click(within(bulkBar).getByRole('button', { name: 'Delete' }));

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(screen.getByText('1 selected')).toBeTruthy();   // toggled nothing
  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(true);                 // moved nothing
  fireEvent.keyDown(window, { key: '/' });
  expect(navigateSpy).not.toHaveBeenCalled();            // went nowhere
});

test('the ring is off entirely on touch chrome', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderPage();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(false);
});

// ── #235 item 4: grid linearity in the wide 2-col layout ─────────────────

test('#235: j walks the wide grid in reading order — row-major, which is DOM order under default grid auto-flow', () => {
  // Four bins fill two grid rows (grid-cols-2): rendered as A B / C D.
  currentChildren = ['A', 'B', 'C', 'D'].map((letter, i) =>
    makeContainer({ id: 10 + i, name: `Nested ${letter}` }));
  renderPage();

  // Reading order of a row-flow 2-col grid is exactly the DOM order the ring
  // walks: left, right, next row — like text. The visual left-right "zigzag"
  // IS that reading order; h/l column movement is deliberately out of scope.
  for (const name of ['Nested A', 'Nested B', 'Nested C', 'Nested D', 'Item A', 'Item B']) {
    fireEvent.keyDown(window, { key: 'j' });
    expect(ringOn(name)).toBe(true);
  }

  // The equivalence only holds under the grid's DEFAULT auto-flow (row).
  // jsdom does no layout, so pin the CSS fact directly: neither section may
  // opt into column flow, which would stride the DOM-ordered ring across
  // rows while the cards visually read down columns.
  for (const rowText of ['Nested A', 'Item A']) {
    const grid = screen.getByText(rowText).closest('button')!.parentElement!.parentElement!;
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).not.toContain('grid-flow-col');
  }
});

// ── #270: the cursor survives the detail round-trip ──────────────────────

test('#270: a cursor in the URL is live on arrival, and j continues from it', () => {
  // What Back actually hands the page: the history entry it left, params and
  // all. Held in useState the highlight was simply gone and the next j
  // re-seeded at row 1 — off-screen, scrolling nothing, because a first
  // landing is deliberately a silent baseline.
  renderPage('/container/1?nav=item:20');

  expect(ringOn('Item A')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Item B')).toBe(true);
  expect(ringOn('Nested A')).toBe(false);
});

test('#270: a cursor naming a row that is not here is not honoured', () => {
  renderPage('/container/1?nav=item:999');
  for (const name of ['Nested A', 'Nested B', 'Item A', 'Item B']) {
    expect(ringOn(name)).toBe(false);
  }
});

// ── Fix round 1 (#231 review, LOW) ──────────────────────────────────────

test('the ring reconciles (clears) when the highlighted row disappears from the list', () => {
  const { rerender } = renderPage();

  fireEvent.keyDown(window, { key: 'j' }); // Nested A
  fireEvent.keyDown(window, { key: 'j' }); // Nested B
  fireEvent.keyDown(window, { key: 'j' }); // Item A
  expect(ringOn('Item A')).toBe(true);

  // Simulate what a bulk delete (#231) does once the invalidated query
  // refetches: Item A is gone. Tracking by index would silently land the
  // ring on whatever now sits in that slot (Item B); tracking by (type, id)
  // key must clear it instead.
  currentItems = [items[1]];
  rerender(
    <MemoryRouter initialEntries={['/container/1']}>
      <Routes>
        <Route path="/container/:containerId" element={<ContainerDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.queryByText('Item A')).toBeNull();
  expect(ringOn('Item B')).toBe(false);
});
