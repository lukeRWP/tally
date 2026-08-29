// @vitest-environment jsdom
/**
 * Bulk Delete and Tag from container-detail's select mode (#231).
 *
 * Select mode already offered Move and Queue over a shift-click / Select-All
 * batch; this adds:
 *  - Delete: one confirm naming counts by kind ("Delete 2 items and 1 bin?"),
 *    recycle-bin language (soft delete, no 409 — container delete always
 *    cascades server-side, see containers.service.js softDelete).
 *  - Tag: opens the existing TagPicker in batch mode (additive only),
 *    applied per selected ITEM only — containers are skipped with a note.
 *
 * Both follow the wave's bulk loop discipline: sequential mutateAsync,
 * continue-on-failure, a truthful outcome toast, failed entities stay
 * selected, and both actions are disabled with a progress label while a
 * loop is running.
 *
 * No @testing-library/jest-dom in this repo (grepped — not installed, no
 * other test uses it), so assertions read raw DOM properties/attributes
 * instead of `toBeInTheDocument`/`toBeDisabled`/`toHaveAttribute`.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { ContainerDetail } from './container-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

// The real TagPicker drags in usePropertyTags/useEntityTags network hooks
// this file has no other reason to wire up. Stub it down to exactly the
// batch-mode contract container-detail.tsx relies on (see
// components/tags/tag-picker.tsx): it captures the `batchMode` it was
// handed and exposes one button that calls `onApply(99)`, so the test can
// drive the same fan-out loop a real dropdown-click would trigger.
let lastBatchMode: { onApply: (tagId: number) => void; busy?: boolean } | null = null;
vi.mock('@/components/tags/tag-picker', () => ({
  TagPicker: (props: { batchMode?: { onApply: (tagId: number) => void; busy?: boolean } }) => {
    lastBatchMode = props.batchMode ?? null;
    if (!props.batchMode) return null;
    return (
      <button disabled={props.batchMode.busy} onClick={() => props.batchMode!.onApply(99)}>
        Apply Fragile
      </button>
    );
  },
}));

const deleteItemMock = vi.fn();
const deleteContainerMock = vi.fn();
const addTagMock = vi.fn();

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

// propertyId > 0 is what turns hasTags (and the bulk Tag button) on.
const container = {
  ...makeContainer({ id: 1, name: 'The Bin', containerCount: 1, itemCount: 2 }),
  propertyId: 7, propertyName: 'Home', areaName: 'Garage',
} as unknown as Container;
const children: Container[] = [makeContainer({ id: 10, name: 'Nested A' })];
const items: Item[] = [makeItem({ id: 20, name: 'Item A' }), makeItem({ id: 21, name: 'Item B' })];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({ data: children, isLoading: false }),
    useItems: () => ({ data: items, isLoading: false }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), mutateAsync: deleteContainerMock, isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: deleteItemMock, isPending: false }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, useAddTag: () => ({ mutateAsync: addTagMock, isPending: false }) };
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

/** The select-mode action bar, scoped so "Delete"/"Move"/"Tag" here never
 * collide with the page's own top-level Delete/Move buttons that share the
 * same label outside select mode. */
function selectBar(): HTMLElement {
  return screen.getByText(/^\d+ selected$/).closest('div') as HTMLElement;
}

function enterSelectModeAndSelectAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(within(selectBar()).getByRole('button', { name: 'All' }));
}

/** aria-pressed on the row's own toggle button — true/false, as a boolean. */
function selected(name: string): boolean {
  // Rows sit behind Radix's aria-hidden wrapper while a modal dialog is
  // open (it hides everything outside the dialog from the accessibility
  // tree), so `hidden: true` is needed to still find them by role then.
  return screen.getByRole('button', { name, hidden: true }).getAttribute('aria-pressed') === 'true';
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  navigateSpy.mockClear();
  toastMock.mockClear();
  deleteItemMock.mockReset().mockResolvedValue({});
  deleteContainerMock.mockReset().mockResolvedValue({});
  addTagMock.mockReset().mockResolvedValue({});
  lastBatchMode = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('Delete over a mixed selection names counts by kind in one confirm, with recycle-bin language', () => {
  renderPage();
  enterSelectModeAndSelectAll(); // 1 bin (Nested A) + 2 items selected

  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Delete 2 items and 1 bin?')).toBeTruthy();
  expect(within(dialog).getByText(/recycle bin/i)).toBeTruthy();
});

test('confirm runs sequential deletes; a rigged failure reports "Deleted 2 · 1 failed" and only the failed row stays selected', async () => {
  deleteItemMock.mockImplementation((id: number) =>
    (id === 21 ? Promise.reject(new Error('boom')) : Promise.resolve({})));

  renderPage();
  enterSelectModeAndSelectAll();

  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Deleted 2 · 1 failed'));

  expect(deleteContainerMock).toHaveBeenCalledWith(10);
  expect(deleteItemMock).toHaveBeenCalledWith(20);
  expect(deleteItemMock).toHaveBeenCalledWith(21);

  // Item B (21) failed and stays selected; the bin and Item A succeeded and
  // are no longer selected.
  expect(selected('Select Item B')).toBe(true);
  expect(selected('Select Item A')).toBe(false);
  expect(selected('Select Nested A')).toBe(false);
});

test('Move, Queue, Tag and Delete are all disabled with a progress label while the delete loop runs', async () => {
  let resolveItem20: (v?: unknown) => void = () => {};
  deleteItemMock.mockImplementation((id: number) => {
    if (id === 20) return new Promise((res) => { resolveItem20 = res; });
    return Promise.resolve({});
  });

  renderPage();
  enterSelectModeAndSelectAll();
  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  // Bin (10) resolves immediately; item 20 is deliberately stuck, so the
  // loop parks at "2 of 3" (bin, then item A, then item B).
  await screen.findByText('Deleting… 2 of 3');

  // The confirm dialog closes as soon as the loop starts (see
  // container-detail.tsx runBulkDelete) — otherwise a modal open the whole
  // time would bury this exact progress label behind it.
  const bar = selectBar();
  expect((within(bar).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(bar).getByRole('button', { name: 'Queue' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(bar).getByRole('button', { name: /^Tag$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(bar).getByText('Deleting… 2 of 3').closest('button') as HTMLButtonElement).disabled).toBe(true);

  await act(async () => { resolveItem20(); });
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Deleted 3'));
});

test('#239: row checkboxes are inert while the delete loop runs, so a mid-loop click cannot be stomped by the end-of-loop selection', async () => {
  let resolveItem20: (v?: unknown) => void = () => {};
  deleteItemMock.mockImplementation((id: number) => {
    if (id === 20) return new Promise((res) => { resolveItem20 = res; });
    return Promise.resolve({});
  });

  renderPage();
  // Select only the two items, leaving the bin (Nested A) unselected and
  // free to click mid-loop.
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Item A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Item B' }));
  expect(selected('Select Nested A')).toBe(false);

  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  // Item A (20) is stuck in flight — the loop is parked mid-run.
  await screen.findByText('Deleting… 1 of 2');
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  // Pre-fix, this click would toggle Nested A into `selected` right away
  // (checkbox mid-loop was never gated) — only to have the loop's own
  // `setSelected(new Set(failed))` silently erase that click's effect the
  // moment the loop finished. Post-fix, the click must be a no-op from the
  // very first frame: it never mutates `selected` at all.
  fireEvent.click(screen.getByRole('button', { name: 'Select Nested A' }));
  expect(selected('Select Nested A')).toBe(false);
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  await act(async () => { resolveItem20(); });
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Deleted 2'));

  // Both items succeeded (no failures) and the bin was never touched by the
  // mid-loop click — final selection is empty, not { container:10 }.
  expect(deleteContainerMock).not.toHaveBeenCalled();
  expect(selected('Select Nested A')).toBe(false);
  expect(selected('Select Item A')).toBe(false);
  expect(selected('Select Item B')).toBe(false);
});

test('#239: "All" stays a no-op while the delete loop runs', async () => {
  let resolveItem20: (v?: unknown) => void = () => {};
  deleteItemMock.mockImplementation((id: number) => {
    if (id === 20) return new Promise((res) => { resolveItem20 = res; });
    return Promise.resolve({});
  });

  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Item A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Item B' }));

  fireEvent.click(within(selectBar()).getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Deleting… 1 of 2');

  // The button carries `disabled`, so a real click is already inert in the
  // browser — this drives the handler directly to pin the invariant even if
  // that prop were ever dropped.
  const allBtn = within(selectBar()).getByRole('button', { name: 'All' }) as HTMLButtonElement;
  expect(allBtn.disabled).toBe(true);
  fireEvent.click(allBtn);
  expect(within(selectBar()).getByText('2 selected')).toBeTruthy();

  await act(async () => { resolveItem20(); });
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Deleted 2'));
});

test('Tag opens the picker in batch mode, applies additively to every selected item, and skips bins with a note', async () => {
  renderPage();
  enterSelectModeAndSelectAll(); // 1 bin + 2 items

  fireEvent.click(within(selectBar()).getByRole('button', { name: /^Tag$/ }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Tags apply to items — skipping 1 bin.')).toBeTruthy();
  expect(lastBatchMode).not.toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Fragile' }));

  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Tagged 2'));

  expect(addTagMock).toHaveBeenCalledWith({ tagId: 99, entityType: 'item', entityId: 20 });
  expect(addTagMock).toHaveBeenCalledWith({ tagId: 99, entityType: 'item', entityId: 21 });
  expect(addTagMock).not.toHaveBeenCalledWith(expect.objectContaining({ entityId: 10 }));

  // Tagged items drop out of the selection; the skipped bin was never
  // touched, so it stays exactly as it was. The dialog is still open (batch
  // mode supports applying more than one tag per visit), so rows are
  // reached with `hidden: true`.
  expect(selected('Select Item A')).toBe(false);
  expect(selected('Select Item B')).toBe(false);
  expect(selected('Select Nested A')).toBe(true);
});

test('fix round 1: applying a second tag in the same dialog visit still reaches the original selection', async () => {
  // Regression for the review's HIGH finding: the first apply drops its
  // succeeded items from `selected`, so a second apply that re-derived its
  // target list from the (now-shrunk) live selection saw zero items and
  // silently no-opped — no addTag calls, no toast. The dialog's working set
  // must be snapshotted once, on open, and stay put across the whole visit.
  renderPage();
  enterSelectModeAndSelectAll(); // 1 bin + 2 items

  fireEvent.click(within(selectBar()).getByRole('button', { name: /^Tag$/ }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Tag 2 items')).toBeTruthy();

  // Apply #1 — both items succeed and drop out of `selected`.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Fragile' }));
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Tagged 2'));

  addTagMock.mockClear();
  toastMock.mockClear();

  // The dialog never closed — its own item count must still read 2, not 0.
  expect(within(dialog).getByText('Tag 2 items')).toBeTruthy();

  // Apply #2, same visit, same stub button (still targets tag 99) — the
  // bug made this a silent no-op: 0 addTag calls, no toast at all.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Fragile' }));
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Tagged 2'));

  expect(addTagMock).toHaveBeenCalledTimes(2);
  expect(addTagMock).toHaveBeenCalledWith({ tagId: 99, entityType: 'item', entityId: 20 });
  expect(addTagMock).toHaveBeenCalledWith({ tagId: 99, entityType: 'item', entityId: 21 });
});

test('a rigged tag failure keeps only the failed item selected', async () => {
  addTagMock.mockImplementation((args: { entityId: number }) =>
    (args.entityId === 21 ? Promise.reject(new Error('boom')) : Promise.resolve({})));

  renderPage();
  enterSelectModeAndSelectAll();
  fireEvent.click(within(selectBar()).getByRole('button', { name: /^Tag$/ }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Fragile' }));

  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Tagged 1 · 1 failed'));

  expect(selected('Select Item A')).toBe(false);
  expect(selected('Select Item B')).toBe(true);
});
