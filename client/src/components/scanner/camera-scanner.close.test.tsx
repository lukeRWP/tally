// @vitest-environment jsdom
/**
 * The scanner's control row (#268).
 *
 * `Stop` pauses the decode loop and is recoverable in one tap. `Close` leaves
 * the scanner — in capture that unmounts the page, taking the held photo Blob,
 * the typed name and any Kept vision fields with it, with no confirm and no
 * undo. They were identical in size and weight and 8px apart on a device
 * driven by a finger.
 *
 * So `onClose` is optional: a caller that has a safer way out passes nothing
 * and the destructive control is not drawn at all. This is the component-level
 * half of that contract; capture's own choice of when to pass it is covered in
 * capture.touch-targets.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CameraScanner } from './camera-scanner';

beforeEach(() => {
  // No getUserMedia in jsdom: start() rejects, the frame settles into its
  // error state, and the control row — the thing under test — renders.
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('onClose given: the Close control is drawn', async () => {
  const onClose = vi.fn();
  render(<CameraScanner isActive onBarcodeScanned={vi.fn()} onClose={onClose} />);

  await waitFor(() => expect(screen.getByRole('button', { name: /close/i })).toBeTruthy());
});

test('onClose omitted: no Close control — and the benign one is untouched', async () => {
  render(<CameraScanner isActive onBarcodeScanned={vi.fn()} />);

  // The start/stop control is the row's whole content now. Nothing next to it
  // can discard a draft.
  await waitFor(() => expect(screen.getByRole('button', { name: /start|stop/i })).toBeTruthy());
  expect(screen.queryByRole('button', { name: /^close$/i })).toBeNull();
});
