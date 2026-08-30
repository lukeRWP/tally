// @vitest-environment jsdom
/**
 * #278 — removing a printer agent had no confirm, even though the agent
 * token is shown exactly once at registration: a mis-click here means
 * re-flashing tally-printer.conf on the Pi from scratch. The remove button
 * also carried no aria-label, so a screen reader announced an empty button
 * next to the printer's name.
 *
 * Mocking follows printer-settings.test.tsx: the data hooks are mocked
 * directly, so no QueryClientProvider or network is needed.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { PrinterSettings } from './printer-settings';
import { usePrinters, usePrintJobs } from '@/hooks/use-print';
import type { Printer } from '@/hooks/use-print';

vi.mock('@/hooks/use-print', () => ({
  usePrinters: vi.fn(),
  usePrintJobs: vi.fn(),
  useCreatePrinter: vi.fn(),
  useRevokePrinter: vi.fn(),
  useSetLoadedMedia: vi.fn(),
  useCancelPrintJob: vi.fn(),
  useRetryPrintJob: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const idleMutation = { mutate: vi.fn(), isPending: false };
const revokeMutation = { mutate: vi.fn(), isPending: false };

function makePrinter(overrides: Partial<Printer>): Printer {
  return {
    id: 1, propertyId: 1, name: 'Garage Pi', loadedMedia: 'small',
    printerState: 'idle', printerStateReasons: [], lastSeenAt: null,
    ...overrides,
  } as Printer;
}

function renderWith(printer: Printer) {
  vi.mocked(usePrinters).mockReturnValue({ data: [printer] } as ReturnType<typeof usePrinters>);
  vi.mocked(usePrintJobs).mockReturnValue({ data: [] } as unknown as ReturnType<typeof usePrintJobs>);
  return render(<PrinterSettings propertyId={1} />);
}

beforeEach(async () => {
  vi.clearAllMocks();
  revokeMutation.mutate = vi.fn();
  revokeMutation.isPending = false;
  const hooks = vi.mocked(await import('@/hooks/use-print'));
  for (const h of [hooks.useCreatePrinter, hooks.useSetLoadedMedia,
                   hooks.useCancelPrintJob, hooks.useRetryPrintJob]) {
    h.mockReturnValue(idleMutation as never);
  }
  hooks.useRevokePrinter.mockReturnValue(revokeMutation as never);
});

test('the remove button is named for the printer, not announced empty', () => {
  renderWith(makePrinter({}));
  expect(screen.getByRole('button', { name: 'Remove Garage Pi' })).toBeTruthy();
});

test('removing a printer asks first and names the irreversibility', () => {
  renderWith(makePrinter({}));

  fireEvent.click(screen.getByRole('button', { name: 'Remove Garage Pi' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Remove Garage Pi?')).toBeTruthy();
  expect(within(dialog).getByText(/can't be undone/i)).toBeTruthy();
  expect(within(dialog).getByText(/re-flashing/i)).toBeTruthy();
  expect(revokeMutation.mutate).not.toHaveBeenCalled();
});

test('cancelling the remove confirm is a no-op', () => {
  renderWith(makePrinter({}));

  fireEvent.click(screen.getByRole('button', { name: 'Remove Garage Pi' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(revokeMutation.mutate).not.toHaveBeenCalled();
});

test('confirming remove calls the mutation with exactly that printer\'s id, once', () => {
  renderWith(makePrinter({ id: 7, name: 'Garage Pi' }));

  fireEvent.click(screen.getByRole('button', { name: 'Remove Garage Pi' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

  expect(revokeMutation.mutate).toHaveBeenCalledTimes(1);
  expect(revokeMutation.mutate.mock.calls[0][0]).toBe(7);
});
