// @vitest-environment jsdom
/**
 * The empty-area create affordance (#229a, task-4 brief).
 *
 * Before this, an area with no bins was a dead end: DestinationPicker could
 * only tell you to go scan the area's own label, with no way to make a bin
 * without abandoning the flow that opened the picker (capture, put-down).
 * "Create a container here" reuses CreateContainerDialog (the same component
 * the sidebar's Add menu uses) seeded with the picker's own area/property, so
 * the only question left is name + type.
 *
 * CreateContainerDialog renders a real Radix Dialog. It is mounted here as a
 * CONTROLLED SIBLING of the picker's bordered panel, not nested inside it —
 * see destination-picker.tsx's comment. Neither of the picker's two real host
 * pages (capture.tsx, put-down.tsx) wraps it in a Dialog/Sheet of their own
 * (confirmed in destination-picker.keyboard-nav.test.tsx's header comment),
 * so there is no Radix Dialog-in-Dialog nesting to worry about here.
 *
 * Mocks follow create-container-dialog.test.tsx's idiom: the hooks module is
 * replaced outright (not merged via importOriginal) because CreateContainerDialog,
 * mounted inside the picker here, pulls from the same module.
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { DestinationPicker, type PickedBin } from './destination-picker';
import { useProperties, useAreas, useContainers, useCreateContainer } from '@/hooks/use-inventory';

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

vi.mock('@/hooks/use-inventory', () => ({
  useProperties: vi.fn(),
  useAreas: vi.fn(),
  useContainers: vi.fn(),
  useCreateContainer: vi.fn(),
}));

let onPick: (bin: PickedBin) => void;
let onClose: () => void;

beforeEach(() => {
  navigateMock.mockClear();
  onPick = vi.fn<(bin: PickedBin) => void>();
  onClose = vi.fn<() => void>();

  vi.mocked(useProperties).mockReturnValue(
    { data: [{ id: 1, name: 'Home' }] } as unknown as ReturnType<typeof useProperties>,
  );
  vi.mocked(useAreas).mockReturnValue(
    { data: [{ id: 5, name: 'Garage' }] } as unknown as ReturnType<typeof useAreas>,
  );
  vi.mocked(useContainers).mockReturnValue(
    { data: [] } as unknown as ReturnType<typeof useContainers>,
  );
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ container: { id: 77, name: 'New Bin', type: 'Box', areaId: 5 } }),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);
});

test('empty-area state renders the create affordance', () => {
  render(
    <DestinationPicker seedPropertyId={1} seedAreaId={5} onPick={onPick} onClose={onClose} />,
  );

  expect(screen.getByText(/no bins in this area yet/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /create a container here/i })).toBeTruthy();
});

test('no create affordance once the area has bins', () => {
  vi.mocked(useContainers).mockReturnValue(
    { data: [{ id: 100, name: 'Bin A', areaId: 5, itemCount: 0 }] } as unknown as ReturnType<typeof useContainers>,
  );

  render(
    <DestinationPicker seedPropertyId={1} seedAreaId={5} onPick={onPick} onClose={onClose} />,
  );

  expect(screen.queryByRole('button', { name: /create a container here/i })).toBeNull();
});

test('completing the create dialog seeds the current area and fires onPick with the new container — no navigation', async () => {
  const mutateAsync = vi.fn().mockResolvedValue({ container: { id: 77, name: 'New Bin', type: 'Box', areaId: 5 } });
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);

  render(
    <DestinationPicker seedPropertyId={1} seedAreaId={5} onPick={onPick} onClose={onClose} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /create a container here/i }));

  // Scoped to the dialog itself: the trigger button ("Create a container
  // here") stays mounted behind it and also matches /create/i, and the
  // area <select> behind it already has an <option>Garage</option> — both
  // would collide with an unscoped query.
  const dialog = within(screen.getByRole('dialog'));

  // Seeded: the area is already answered, so the dialog shows the
  // confirmation line, not a fresh property/area choice.
  expect(dialog.getByText(/goes in/i)).toBeTruthy();
  expect(dialog.getByText('Garage')).toBeTruthy();

  fireEvent.change(dialog.getByLabelText(/^name/i), { target: { value: 'New Bin' } });
  fireEvent.change(dialog.getByLabelText(/^type/i), { target: { value: 'Box' } });
  fireEvent.click(dialog.getByRole('button', { name: /^create$/i }));

  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'New Bin', type: 'Box', areaId: 5 }),
  ));

  await waitFor(() => expect(onPick).toHaveBeenCalledWith({ id: 77, name: 'New Bin', areaId: 5 }));
  // The picker owns this destination now — CreateContainerDialog's default
  // "go look at it" navigation would yank the user out of the flow that
  // opened the picker (capture, put-down).
  expect(navigateMock).not.toHaveBeenCalled();
});

test('works exactly as ManualCreate mounts it (seedAreaId + seedPropertyId only, default property selector)', async () => {
  // capture.tsx's ManualCreate renders DestinationPicker with just these two
  // seeds and no showPropertySelector override — same as the flow's own
  // picker at phase 'place'. The create affordance must not depend on some
  // prop only one call site happens to pass.
  const mutateAsync = vi.fn().mockResolvedValue({ container: { id: 88, name: 'Desk Bin', type: 'Box', areaId: 5 } });
  vi.mocked(useCreateContainer).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateContainer>);

  render(
    <DestinationPicker seedAreaId={5} seedPropertyId={1} onPick={onPick} onClose={onClose} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /create a container here/i }));

  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText(/^name/i), { target: { value: 'Desk Bin' } });
  fireEvent.change(dialog.getByLabelText(/^type/i), { target: { value: 'Box' } });
  fireEvent.click(dialog.getByRole('button', { name: /^create$/i }));

  await waitFor(() => expect(onPick).toHaveBeenCalledWith({ id: 88, name: 'Desk Bin', areaId: 5 }));
});
