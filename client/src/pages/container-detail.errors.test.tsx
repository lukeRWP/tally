// @vitest-environment jsdom
/**
 * Container-detail's two child-list queries (nested containers, items) did
 * not destructure `isError` (#95), so a failed fetch rendered the "No nested
 * containers" / "No items in this container" empty copy — a silent blank
 * section indistinguishable from a genuinely empty bin.
 *
 * This locks in the fix: a failed child fetch renders a SectionError with a
 * Retry that calls that query's own `refetch`, ahead of the empty-state
 * check — and does so without touching the parent container's own
 * load/error handling or the select-mode/keyboard-ring logic, which are
 * exercised by container-detail.bulk.test.tsx and
 * container-detail.keyboard-nav.test.tsx respectively.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Container, Item } from '@/types/inventory';
import { ContainerDetail } from './container-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/components/tags/tag-picker', () => ({ TagPicker: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));
vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, useAddTag: () => ({ mutateAsync: vi.fn(), isPending: false }) };
});

const container = {
  id: 1, areaId: 5, parentContainerId: null, name: 'The Bin', type: 'box',
  description: null, qrCode: 'TLY-C-1', containerCount: 0, itemCount: 0,
  breadcrumb: [], propertyId: 7, propertyName: 'Home', areaName: 'Garage',
} as unknown as Container;

const refetchChildrenMock = vi.fn();
const refetchItemsMock = vi.fn();

let childrenState: { data: Container[] | undefined; isError: boolean } = { data: [], isError: false };
let itemsState: { data: Item[] | undefined; isError: boolean } = { data: [], isError: false };

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({
      data: childrenState.data,
      isLoading: false,
      isError: childrenState.isError,
      refetch: refetchChildrenMock,
    }),
    useItems: () => ({
      data: itemsState.data,
      isLoading: false,
      isError: itemsState.isError,
      refetch: refetchItemsMock,
    }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

beforeEach(() => {
  childrenState = { data: [], isError: false };
  itemsState = { data: [], isError: false };
  refetchChildrenMock.mockClear();
  refetchItemsMock.mockClear();
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

test('a failed nested-containers fetch shows an error with Retry instead of the empty state', () => {
  childrenState = { data: undefined, isError: true };
  renderPage();

  expect(screen.getByText("Couldn't load nested containers.")).toBeTruthy();
  expect(screen.queryByText('No nested containers')).toBeNull();
  // The items section fetched fine — its own empty copy still shows.
  expect(screen.getByText('No items in this container')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(refetchChildrenMock).toHaveBeenCalledTimes(1);
});

test('a failed items fetch shows an error with Retry instead of the empty state', () => {
  itemsState = { data: undefined, isError: true };
  renderPage();

  expect(screen.getByText("Couldn't load items.")).toBeTruthy();
  expect(screen.queryByText('No items in this container')).toBeNull();
  // The nested-containers section fetched fine — its own empty copy still shows.
  expect(screen.getByText('No nested containers')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(refetchItemsMock).toHaveBeenCalledTimes(1);
});
