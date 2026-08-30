// @vitest-environment jsdom
/**
 * #283 — item-detail's ledger showed a wrong label AND a wrong value before
 * its secondary queries landed.
 *
 * The Dates row read `itemDates?.[0]?.dateType || 'Warranty'` and the Lending
 * row `openLoan?.lentTo ?? 'Someone'`. Measured with an rAF sampler against an
 * item lent to "Marcus Webb" carrying a date of type "Service due": whenever
 * /api/items answered faster than /api/dates and /api/lending, the ledger
 * spent 125ms showing a row labelled "Warranty" offering "+ add" — asserting
 * the item has no dates, on an item that has one — and "Lent to · Someone", a
 * placeholder that reads exactly like a real answer. BOTH rows were clickable
 * in that window, so clicking "+ add" opened the add-date dialog for an item
 * that already had a date. A mis-click hazard, not only a flicker.
 *
 * There is no flash at all when /api/items is the slowest of the three, which
 * is the likely production case — so these tests drive the case that is not.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { ItemDetail } from './item-detail';

// ---- the three queries this file is about --------------------------------
let itemDates: unknown[] | undefined;
let lendingHistory: unknown[] | undefined;
let itemStatus: 'active' | 'lent' = 'lent';

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useParams: () => ({ id: '1' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/use-dates', () => ({ useItemDates: () => ({ data: itemDates }) }));
vi.mock('@/hooks/use-lending', () => ({ useLendingHistory: () => ({ data: lendingHistory }) }));

vi.mock('@/hooks/use-inventory', () => ({
  useItem: () => ({
    data: {
      id: 1,
      name: 'Cordless Drill',
      quantity: 1,
      condition: 'good',
      status: itemStatus,
      containerId: 1,
      qrCode: 'TLY-I-0001',
      purchasePrice: 189.99,
      description: null,
      breadcrumb: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

// Everything else the page mounts is irrelevant here and mostly fetches.
vi.mock('@/hooks/use-files', () => ({
  useItemFiles: () => ({ data: [] }),
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConditionHistory: () => ({ data: [] }),
}));
vi.mock('@/hooks/use-accessories', () => ({ useAccessories: () => ({ data: [] }) }));
vi.mock('@/hooks/use-notifications', () => ({ useEntityHistory: () => ({ data: [] }) }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'sidebar' }));
vi.mock('@/hooks/use-keyboard-nav', () => ({ useKeyboardNav: () => {} }));
vi.mock('@/store/carry-store', () => ({
  useCarryStore: (sel: (s: unknown) => unknown) => sel({ carried: [], addItem: vi.fn(), lastMove: null }),
}));
vi.mock('@/components/layout/breadcrumbs', () => ({ Breadcrumbs: () => null }));
vi.mock('@/components/files/file-list', () => ({ FileList: () => null }));
vi.mock('@/components/files/file-upload', () => ({ FileUpload: () => null }));
vi.mock('@/components/condition/condition-timeline', () => ({ ConditionTimeline: () => null }));
vi.mock('@/components/condition/condition-form', () => ({ ConditionForm: () => null }));
vi.mock('@/components/tags/tag-picker', () => ({ TagPicker: () => null }));
vi.mock('@/components/dates/date-list', () => ({ DateList: () => null }));
vi.mock('@/components/dates/date-form', () => ({ DateForm: () => null }));
vi.mock('@/components/accessories/accessory-list', () => ({ AccessoryList: () => null }));
vi.mock('@/components/accessories/accessory-picker', () => ({ AccessoryPicker: () => null }));
vi.mock('@/components/lending/lending-list', () => ({ LendingList: () => null }));
vi.mock('@/components/lending/lend-form', () => ({ LendForm: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/components/inventory/field-dialog', () => ({ FieldDialog: () => null }));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

beforeEach(() => {
  itemDates = undefined;
  lendingHistory = undefined;
  itemStatus = 'lent';
});

function renderPage() {
  return render(<MemoryRouter><ItemDetail /></MemoryRouter>);
}

test('while /api/dates is in flight the row claims no date type and offers no "+ add"', () => {
  renderPage();

  // "Warranty" is a fallback, and asserting it on an item whose date type is
  // "Service due" is a statement, not a placeholder.
  expect(screen.queryByText('Warranty')).toBeNull();
  expect(screen.queryByRole('button', { name: /add warranty/i })).toBeNull();
});

test('when the dates land, the row states the real type', () => {
  itemDates = [{ id: 1, itemId: 1, dateType: 'Service due', dateValue: '2026-11-02T00:00:00Z' }];
  renderPage();

  expect(screen.getByText('Service due')).toBeTruthy();
});

test('an item with no dates gets the "+ add" invitation once that is actually known', () => {
  itemDates = [];
  renderPage();

  expect(screen.getByText('Warranty')).toBeTruthy();
  expect(screen.getByRole('button', { name: /add warranty/i })).toBeTruthy();
});

test('a lent item never says "Someone" while the loan is still loading', () => {
  renderPage();

  expect(screen.queryByText('Someone')).toBeNull();
  expect(screen.queryByRole('button', { name: /edit lent to/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /add lent to/i })).toBeNull();
});

test('when the loan lands the row names the borrower', () => {
  lendingHistory = [{ id: 1, itemId: 1, lentTo: 'Marcus Webb', lentAt: '2026-08-01T00:00:00Z', returnedAt: null }];
  renderPage();

  expect(screen.getByText('Marcus Webb')).toBeTruthy();
});

test('an item that is NOT lent offers "+ add" immediately — that fact came with the item itself', () => {
  itemStatus = 'active';
  renderPage();

  // No waiting on the lending query: the item already said it is not out.
  expect(screen.getByRole('button', { name: /add lent to/i })).toBeTruthy();
});

test('the pending rows keep their slot, so the ledger does not jump when the answers land', () => {
  const { container } = renderPage();
  const pendingRows = container.querySelectorAll('.min-h-\\[44px\\]').length;

  itemDates = [{ id: 1, itemId: 1, dateType: 'Service due', dateValue: '2026-11-02T00:00:00Z' }];
  lendingHistory = [{ id: 1, itemId: 1, lentTo: 'Marcus Webb', lentAt: '2026-08-01T00:00:00Z', returnedAt: null }];
  const { container: settled } = renderPage();

  expect(settled.querySelectorAll('.min-h-\\[44px\\]').length).toBe(pendingRows);
});
