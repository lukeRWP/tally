// @vitest-environment jsdom
/**
 * #284 — "N selected" and the bulk progress label moved in OPPOSITE
 * directions during a delete loop.
 *
 * The select-mode bar's ghost-pruning effect drops a row from `selected` the
 * moment an invalidated query stops returning it — which, for the row a
 * delete just succeeded on, happens WHILE the loop is still running the rest
 * of the batch. So "N selected" counted DOWN (10 -> 9 -> 8...) at the same
 * time "Deleting… i of total" counted UP — both numbers true, together
 * reading as a contradiction.
 *
 * Fix: while `bulkRunning`, the header freezes on the progress object's
 * `total` (set once per loop, never mutated) instead of live `selected.size`.
 *
 * This drives a REAL two-step delete loop with deferred mutations, mutating
 * the mocked `useContainerChildren`/`useItems` data and re-rendering between
 * steps to simulate the query invalidation a real success would trigger —
 * the same shape as matches.advance.test.tsx's "rows fresh at success time"
 * test.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { ContainerDetail } from './container-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/tags/tag-picker', () => ({ TagPicker: () => null }));

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

const container = {
  ...makeContainer({ id: 1, name: 'The Bin' }),
  propertyId: 7, propertyName: 'Home', areaName: 'Garage',
} as unknown as Container;

// Mutated mid-test to simulate a mutation's onSuccess invalidation shrinking
// the list — read fresh by the mocked hooks below on every render.
let mockChildren: Container[] = [];
let mockItems: Item[] = [makeItem({ id: 20, name: 'Item A' }), makeItem({ id: 21, name: 'Item B' })];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({ data: mockChildren, isLoading: false }),
    useItems: () => ({ data: mockItems, isLoading: false }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: deleteItemMutateAsync, isPending: false }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, useAddTag: () => ({ mutateAsync: vi.fn(), isPending: false }) };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let pending: ReturnType<typeof deferred<unknown>>[] = [];
const deleteItemMutateAsync = vi.fn(() => {
  const d = deferred<unknown>();
  pending.push(d);
  return d.promise;
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/container/1']}>
      <Routes>
        <Route path="/container/:containerId" element={<ContainerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function selectBar(): HTMLElement {
  return screen.getByText(/^\d+ selected$/).closest('div') as HTMLElement;
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  mockChildren = [];
  mockItems = [makeItem({ id: 20, name: 'Item A' }), makeItem({ id: 21, name: 'Item B' })];
  pending = [];
  deleteItemMutateAsync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('the "N selected" count freezes at the batch size while a delete loop runs, instead of counting down against the progress label', async () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(within(selectBar()).getByRole('button', { name: 'All' }));
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  // The loop is now running: item A's delete is in flight (deferred), and
  // the progress label already reads 1 of 2.
  expect(within(selectBar()).getByText('Deleting… 1 of 2')).toBeTruthy();
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  // Resolve item A's delete AND simulate the invalidated query's refetch
  // dropping it from `items` — exactly what a real onSuccess would produce —
  // in the same act() flush the ghost-pruning effect would run in.
  await act(async () => {
    pending[0].resolve({});
    mockItems = mockItems.filter((i) => i.id !== 20);
  });

  // The loop has moved on to item B (2 of 2) — pre-fix, "selected" would now
  // read "1 selected" (pruned down to what `mockItems` still contains) while
  // the progress label reads "2 of 2", a direct contradiction. Post-fix it
  // stays frozen at the original batch size for the whole loop.
  expect(within(selectBar()).getByText('Deleting… 2 of 2')).toBeTruthy();
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  await act(async () => {
    pending[1].resolve({});
    mockItems = [];
  });

  // Loop finished with no failures: `selected` is now genuinely empty (not
  // frozen — bulkRunning is false again), and the bar reflects that honestly.
  expect(within(selectBar()).getByText('0 selected')).toBeTruthy();
});
