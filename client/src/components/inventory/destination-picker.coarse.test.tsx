// @vitest-environment jsdom
/**
 * #235 item 3: the picker's ring gates on the pointer.
 *
 * Every page surface turns its ring off in touch chrome (useLayoutMode);
 * the picker has no layout mode of its own, so it gates on useCoarsePointer
 * instead — the same signal capture.tsx forks its input modality on. A
 * coarse-only tablet fires no j/k today, but a bluetooth keyboard would, and
 * half a pattern (moves but mismatched chrome) is worse than none.
 *
 * The sibling keyboard-nav suite runs with NO matchMedia at all — jsdom's
 * default — which useCoarsePointer reads as fine-pointer, so those tests
 * double as the enabled-at-a-desk case without stubbing anything.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DestinationPicker, type PickedBin } from './destination-picker';

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({ data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }] }),
    useAreas: () => ({ data: [{ id: 5, name: 'Garage', propertyId: 1, description: null, qrCode: 'TLY-A-0005', containerCount: 2, itemCount: 2 }] }),
    useContainers: () => ({
      data: [
        { id: 100, name: 'Bin A', areaId: 5, itemCount: 2 },
        { id: 101, name: 'Bin B', areaId: 5, itemCount: 0 },
      ],
    }),
  };
});

function stubPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: coarse,
    media: '(pointer: coarse)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function ringOn(text: string): boolean {
  return screen.getByText(text).closest('button')!.className.includes('ring-1');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPicker(onPick: (bin: PickedBin) => void) {
  return render(
    <DestinationPicker
      seedPropertyId={1}
      seedAreaId={5}
      showPropertySelector={false}
      onPick={onPick}
      onClose={vi.fn()}
    />,
  );
}

test('coarse pointer: the ring is off — j moves nothing, Enter picks nothing', () => {
  stubPointer(true);
  const onPick = vi.fn();
  renderPicker(onPick);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Bin A')).toBe(false);

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(onPick).not.toHaveBeenCalled();
});

test('fine pointer (explicit matchMedia): the ring works, proving the gate reads the signal', () => {
  stubPointer(false);
  const onPick = vi.fn();
  renderPicker(onPick);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Bin A')).toBe(true);

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(onPick).toHaveBeenCalledWith({ id: 100, name: 'Bin A', areaId: 5 });
});
