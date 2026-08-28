// @vitest-environment jsdom
/**
 * Keyboard nav on the destination picker (#225, task-4 brief).
 *
 * This panel renders inline inside capture.tsx and put-down.tsx (not a real
 * Radix Dialog — just a conditionally-mounted panel with its own X-button
 * close), and BOTH host pages already run their own window-level Escape
 * handling for the surrounding flow (put-down.tsx's Esc-as-Done in
 * particular). So this ring deliberately does NOT wire `onEscape` — Escape
 * must reach whatever the host page already does with it, untouched. The
 * last test here proves that: a parent's own keydown handler still sees the
 * Escape event, and the picker's own onClose is never called by the ring.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

function ringOn(text: string): boolean {
  return screen.getByText(text).closest('button')!.className.includes('ring-1');
}

let onPick: (bin: PickedBin) => void;
let onClose: () => void;

beforeEach(() => {
  onPick = vi.fn<(bin: PickedBin) => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPicker() {
  return render(
    <DestinationPicker
      seedPropertyId={1}
      seedAreaId={5}
      showPropertySelector={false}
      onPick={onPick}
      onClose={onClose}
    />,
  );
}

test('j/k walks the bin list', () => {
  renderPicker();

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Bin A')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Bin B')).toBe(true);
  expect(ringOn('Bin A')).toBe(false);

  fireEvent.keyDown(window, { key: 'k' });
  expect(ringOn('Bin A')).toBe(true);
});

test('Enter picks the highlighted bin', () => {
  renderPicker();

  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'Enter' });

  expect(onPick).toHaveBeenCalledWith({ id: 101, name: 'Bin B', areaId: 5 });
});

test('keys are inert while the area <select> has focus (isTyping) — Enter included', () => {
  renderPicker();
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' }); // Bin B highlighted, per the previous test's shape
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(onPick).toHaveBeenCalledTimes(1);

  const areaSelect = screen.getByDisplayValue('Garage') as HTMLSelectElement;
  areaSelect.focus();
  fireEvent.keyDown(areaSelect, { key: 'j' });
  fireEvent.keyDown(areaSelect, { key: 'Enter' });

  // Neither reached the ring: movement didn't fire, and Enter didn't re-pick.
  expect(onPick).toHaveBeenCalledTimes(1);
});

test('Escape is not wired here — the picker never closes itself, and a parent still sees the keypress', () => {
  const parentKeyDown = vi.fn();
  render(
    <div onKeyDown={parentKeyDown}>
      <DestinationPicker
        seedPropertyId={1}
        seedAreaId={5}
        showPropertySelector={false}
        onPick={onPick}
        onClose={onClose}
      />
    </div>,
  );

  fireEvent.keyDown(screen.getByText('Bin A'), { key: 'Escape' });

  expect(onClose).not.toHaveBeenCalled();
  expect(parentKeyDown).toHaveBeenCalledTimes(1);
});
