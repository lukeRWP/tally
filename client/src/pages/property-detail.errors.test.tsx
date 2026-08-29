// @vitest-environment jsdom
/**
 * Property-detail's areas child-list query did not destructure `isError`
 * (#95), so a failed fetch rendered the "No areas yet" empty state instead
 * of telling the user anything went wrong. This locks in the fix: an error
 * branch (shared `ErrorState`, matching this section's existing
 * centered-block empty-state shape) renders ahead of the empty check, with
 * a Retry that calls the query's own `refetch`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import type { Property } from '@/types/inventory';
import { PropertyDetail } from './property-detail';

vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));

const property = {
  id: 1, name: 'Home', address: null, description: null,
  qrCode: 'TLY-P-1', areaCount: 0, containerCount: 0, itemCount: 0,
} as unknown as Property;

const refetchAreasMock = vi.fn();

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperty: () => ({ data: property, isLoading: false, isError: false, refetch: vi.fn() }),
    useAreas: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchAreasMock,
    }),
    useCreateArea: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteProperty: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/property/1']}>
      <Routes>
        <Route path="/property/:propertyId" element={<PropertyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('a failed areas fetch shows an error with Retry instead of the empty state', () => {
  renderPage();

  expect(screen.getByText("Couldn't load areas.")).toBeTruthy();
  expect(screen.queryByText('No areas yet')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /try again/i }));
  expect(refetchAreasMock).toHaveBeenCalledTimes(1);
});
