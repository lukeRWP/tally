// @vitest-environment jsdom
/**
 * CreateContainerDialog composes EntityForm's `type="container"` form with a
 * "where does it live" section that only appears when the caller hasn't
 * already answered the question via seedAreaId/seedAreaName/seedPropertyId.
 *
 * The three data hooks (useProperties, useAreas, useCreateContainer) are
 * mocked directly — following capture.kill-switch.test.tsx's vi.mock idiom —
 * so no QueryClientProvider or real network is needed. useNavigate is mocked
 * the same way, so no Router wrapper is needed either: nothing else in the
 * tree touches routing.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { CreateContainerDialog } from './create-container-dialog';
import { useProperties, useAreas, useCreateContainer } from '@/hooks/use-inventory';

const navigateMock = vi.fn();
vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

vi.mock('@/hooks/use-inventory', () => ({
  useProperties: vi.fn(),
  useAreas: vi.fn(),
  useCreateContainer: vi.fn(),
}));

// EntityForm appends a required-marker span ("Name *") to the <label>, so an
// exact-text match against "Name" fails — match the leading word instead.
function fillNameAndType() {
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Bin 1' } });
  fireEvent.change(screen.getByLabelText(/^type/i), { target: { value: 'Box' } });
}

beforeEach(() => {
  navigateMock.mockClear();
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ container: { id: 77, name: 'Bin 1', type: 'Box', areaId: 5 } }),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);
});

test('seeded: shows the location confirmation, no property buttons, no area select', () => {
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({ data: [{ id: 5, name: 'Garage' }] } as unknown as ReturnType<typeof useAreas>);

  render(
    <CreateContainerDialog
      open
      onOpenChange={() => {}}
      seedAreaId={5}
      seedAreaName="Garage"
      seedPropertyId={1}
    />,
  );

  expect(screen.getByText(/goes in/i)).toBeTruthy();
  expect(screen.getByText('Garage')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
  expect(screen.queryByLabelText('Area')).toBeNull();
});

test('unseeded, single property with areas: no property buttons, area select lists areas, submit gates on area choice', () => {
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({
    data: [{ id: 5, name: 'Garage' }, { id: 6, name: 'Attic' }],
  } as unknown as ReturnType<typeof useAreas>);

  render(<CreateContainerDialog open onOpenChange={() => {}} />);

  expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();

  const areaSelect = screen.getByLabelText('Area') as HTMLSelectElement;
  expect(screen.getByRole('option', { name: 'Garage' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Attic' })).toBeTruthy();

  const submit = screen.getByRole('button', { name: /create/i }) as HTMLButtonElement;
  fillNameAndType();
  // Name + type alone don't unlock it — no area has been picked yet.
  expect(submit.disabled).toBe(true);

  fireEvent.change(areaSelect, { target: { value: '5' } });
  expect(submit.disabled).toBe(false);
});

test('unseeded, multiple properties: segmented property buttons render, and switching resets the area choice', () => {
  vi.mocked(useProperties).mockReturnValue({
    data: [{ id: 1, name: 'Home' }, { id: 2, name: 'Cabin' }],
  } as unknown as ReturnType<typeof useProperties>);
  // Two areas per property — the sole-area auto-select (tested separately
  // below) must not mask this test's own assertion that switching properties
  // clears back to the placeholder.
  vi.mocked(useAreas).mockImplementation((propertyId: number) => ({
    data: propertyId === 2
      ? [{ id: 9, name: 'Loft' }, { id: 10, name: 'Study' }]
      : [{ id: 5, name: 'Garage' }, { id: 6, name: 'Attic' }],
  }) as unknown as ReturnType<typeof useAreas>);

  render(<CreateContainerDialog open onOpenChange={() => {}} />);

  expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cabin' })).toBeTruthy();

  const areaSelect = screen.getByLabelText('Area') as HTMLSelectElement;
  fireEvent.change(areaSelect, { target: { value: '5' } });
  expect(areaSelect.value).toBe('5');

  fireEvent.click(screen.getByRole('button', { name: 'Cabin' }));

  expect((screen.getByLabelText('Area') as HTMLSelectElement).value).toBe('');
});

test('unseeded, single property with exactly one area: auto-selects it, submit works without touching the select', async () => {
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({ data: [{ id: 5, name: 'Garage' }] } as unknown as ReturnType<typeof useAreas>);
  const mutateAsync = vi.fn().mockResolvedValue({ container: { id: 88, name: 'Bin 1', type: 'Box', areaId: 5 } });
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);

  render(<CreateContainerDialog open onOpenChange={() => {}} />);

  // The sole area is already the effective selection — no click needed.
  expect((screen.getByLabelText('Area') as HTMLSelectElement).value).toBe('5');

  fillNameAndType();
  expect((screen.getByRole('button', { name: /create/i }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /create/i }));

  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ areaId: 5 }),
  ));
});

test('closing resets the where-section back to defaults for the next open', () => {
  vi.mocked(useProperties).mockReturnValue({
    data: [{ id: 1, name: 'Home' }, { id: 2, name: 'Cabin' }],
  } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockImplementation((propertyId: number) => ({
    data: propertyId === 2
      ? [{ id: 9, name: 'Loft' }, { id: 10, name: 'Study' }]
      : [{ id: 5, name: 'Garage' }, { id: 6, name: 'Attic' }],
  }) as unknown as ReturnType<typeof useAreas>);

  const { rerender } = render(<CreateContainerDialog open onOpenChange={() => {}} />);

  // Wander away from the defaults: a different property, a picked area.
  fireEvent.click(screen.getByRole('button', { name: 'Cabin' }));
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: '9' } });
  expect((screen.getByLabelText('Area') as HTMLSelectElement).value).toBe('9');

  // Close — the component itself stays mounted in the real sidebar; only
  // `open` changes. Reopen and check the wandering didn't survive.
  rerender(<CreateContainerDialog open={false} onOpenChange={() => {}} />);
  rerender(<CreateContainerDialog open onOpenChange={() => {}} />);

  expect(screen.getByRole('button', { name: 'Home' }).className.split(' ')).toContain('bg-[var(--color-text)]');
  expect(screen.getByRole('button', { name: 'Cabin' }).className.split(' ')).not.toContain('bg-[var(--color-text)]');
  expect((screen.getByLabelText('Area') as HTMLSelectElement).value).toBe('');
});

test('unseeded, property with zero areas: shows guidance, no area select, submit stays disabled', () => {
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useAreas>);

  render(<CreateContainerDialog open onOpenChange={() => {}} />);

  expect(screen.getByText(/no areas here yet.*create one on the areas page first/i)).toBeTruthy();
  expect(screen.queryByLabelText('Area')).toBeNull();

  fillNameAndType();
  expect((screen.getByRole('button', { name: /create/i }) as HTMLButtonElement).disabled).toBe(true);
});

test('unseeded, areas still loading (data undefined): shows neither the guidance line nor an enabled submit', () => {
  // useAreas has no keepPreviousData, so a property switch blanks `data` for
  // the whole refetch. undefined means LOADING, not EMPTY — it must not be
  // treated as "this property has zero areas" (that's a separate state,
  // covered above with `data: []`).
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useAreas>);

  render(<CreateContainerDialog open onOpenChange={() => {}} />);

  expect(screen.queryByText(/no areas here yet/i)).toBeNull();
  expect(screen.getByLabelText('Area')).toBeTruthy();
  expect(screen.getByText(/loading areas/i)).toBeTruthy();

  fillNameAndType();
  expect((screen.getByRole('button', { name: /create/i }) as HTMLButtonElement).disabled).toBe(true);
});

test('successful create navigates to the new container and closes the dialog', async () => {
  vi.mocked(useProperties).mockReturnValue({ data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>);
  vi.mocked(useAreas).mockReturnValue({ data: [{ id: 5, name: 'Garage' }] } as unknown as ReturnType<typeof useAreas>);
  const mutateAsync = vi.fn().mockResolvedValue({ container: { id: 77, name: 'Bin 1', type: 'Box', areaId: 5 } });
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);
  const onOpenChange = vi.fn();

  render(<CreateContainerDialog open onOpenChange={onOpenChange} />);

  fillNameAndType();
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: /create/i }));

  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Bin 1', type: 'Box', areaId: 5 }),
  ));
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/container/77'));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
