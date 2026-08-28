// @vitest-environment jsdom
/**
 * Keyboard nav on the container detail page (#225, task-4 brief).
 *
 * One ring over the VISIBLE order: nested-bin cards THEN item rows, exactly
 * as rendered — Enter navigates to whichever kind is highlighted. Off while
 * the batch-select checkboxes are up ("Select" mode), since Enter jumping to
 * a whole other page would fight that flow.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
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

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({ data: children, isLoading: false }),
    useItems: () => ({ data: items, isLoading: false }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

/** The div this file's ring styling is applied to, one level above the row's own button. */
function ringOn(text: string): boolean {
  const el = screen.getByText(text).closest('button')?.parentElement;
  return !!el?.className.includes('ring-1');
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/container/1']}>
      <Routes>
        <Route path="/container/:containerId" element={<ContainerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  navigateSpy.mockClear();
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

test('the ring is disabled while the batch-select checkboxes are up', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(false);

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(navigateSpy).not.toHaveBeenCalled();
});

test('the ring is off entirely on touch chrome', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderPage();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Nested A')).toBe(false);
});
