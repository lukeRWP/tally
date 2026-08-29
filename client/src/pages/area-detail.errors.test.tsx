// @vitest-environment jsdom
/**
 * Area-detail's containers child-list query did not destructure `isError`
 * (#95), so a failed fetch rendered the "No containers yet" empty state
 * instead of telling the user anything went wrong. This locks in the fix:
 * an error branch (shared `ErrorState`, matching this section's existing
 * centered-block empty-state shape) renders ahead of the empty check, with
 * a Retry that calls the query's own `refetch`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, test, vi } from 'vitest';
import type { Area } from '@/types/inventory';
import { AreaDetail } from './area-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));

// propertyId: 0 keeps TagPicker (which needs its own network hooks) off screen.
const area = {
  id: 1, propertyId: 0, name: 'Garage', description: null,
  qrCode: 'TLY-A-1', containerCount: 0, itemCount: 0,
} as unknown as Area;

const refetchContainersMock = vi.fn();

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useArea: () => ({ data: area, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainers: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchContainersMock,
    }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteArea: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/area/1']}>
      <Routes>
        <Route path="/area/:areaId" element={<AreaDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('a failed containers fetch shows an error with Retry instead of the empty state', () => {
  renderPage();

  expect(screen.getByText("Couldn't load containers.")).toBeTruthy();
  expect(screen.queryByText('No containers yet')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /try again/i }));
  expect(refetchContainersMock).toHaveBeenCalledTimes(1);
});
