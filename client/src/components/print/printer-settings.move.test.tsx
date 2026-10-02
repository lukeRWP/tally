// @vitest-environment jsdom
/**
 * Move a registered printer to another property the caller owns, keeping its
 * saved credential (tp_ token or pwk_ key) — no SD-card change on the Pi.
 *
 * Mocking follows printer-settings.test.tsx: the data hooks are mocked
 * directly, so no QueryClientProvider or network is needed.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { PrinterSettings } from './printer-settings';
import { usePrinters, usePrintJobs } from '@/hooks/use-print';
import { useProperties } from '@/hooks/use-inventory';
import type { Printer } from '@/hooks/use-print';
import type { Property } from '@/types/inventory';

vi.mock('@/hooks/use-print', () => ({
  usePrinters: vi.fn(),
  usePrintJobs: vi.fn(),
  useCreatePrinter: vi.fn(),
  useRevokePrinter: vi.fn(),
  useSetLoadedMedia: vi.fn(),
  useCancelPrintJob: vi.fn(),
  useRetryPrintJob: vi.fn(),
  useBindServiceAccount: vi.fn(),
  useUnbindServiceAccount: vi.fn(),
  useMovePrinter: vi.fn(),
}));
vi.mock('@/hooks/use-inventory', () => ({
  useProperties: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const idleMutation = { mutate: vi.fn(), isPending: false };
const moveMutation = { mutate: vi.fn(), isPending: false };

function makePrinter(overrides: Partial<Printer>): Printer {
  return {
    id: 1, propertyId: 1, name: 'Garage Pi', loadedMedia: 'small',
    printerState: 'idle', printerStateReasons: [], lastSeenAt: null,
    serviceAccountId: null,
    ...overrides,
  } as Printer;
}

function makeProperty(overrides: Partial<Property>): Property {
  return {
    id: 1, name: 'House', address: null, description: null, qrCode: 'TLY-P-1',
    role: 'owner', areaCount: 0, containerCount: 0, itemCount: 0, createdAt: '',
    ...overrides,
  } as Property;
}

function renderWith(printer: Printer | null, properties: Property[], propertyId = 1, onMoved?: (id: number) => void) {
  vi.mocked(usePrinters).mockReturnValue({ data: printer ? [printer] : [] } as ReturnType<typeof usePrinters>);
  vi.mocked(usePrintJobs).mockReturnValue({ data: [] } as unknown as ReturnType<typeof usePrintJobs>);
  vi.mocked(useProperties).mockReturnValue({ data: properties } as unknown as ReturnType<typeof useProperties>);
  return render(<PrinterSettings propertyId={propertyId} onMoved={onMoved} />);
}

beforeEach(async () => {
  vi.clearAllMocks();
  moveMutation.mutate = vi.fn();
  moveMutation.isPending = false;
  const hooks = vi.mocked(await import('@/hooks/use-print'));
  for (const h of [hooks.useCreatePrinter, hooks.useRevokePrinter, hooks.useSetLoadedMedia,
                   hooks.useCancelPrintJob, hooks.useRetryPrintJob,
                   hooks.useBindServiceAccount, hooks.useUnbindServiceAccount]) {
    h.mockReturnValue(idleMutation as never);
  }
  hooks.useMovePrinter.mockReturnValue(moveMutation as never);
});

test('the move control is hidden when there is no other property the caller owns', () => {
  renderWith(makePrinter({}), [makeProperty({ id: 1, role: 'owner' })]);
  expect(screen.queryByText('Move to another property')).toBeNull();
});

test('a property where the caller is only an editor/viewer is not offered as a destination', () => {
  renderWith(makePrinter({}), [
    makeProperty({ id: 1, role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'editor' }),
    makeProperty({ id: 3, name: 'Beach House', role: 'viewer' }),
  ]);
  expect(screen.queryByText('Move to another property')).toBeNull();
});

test('another owned property shows the move control with it as a destination option', () => {
  renderWith(makePrinter({}), [
    makeProperty({ id: 1, role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);
  expect(screen.getByText('Move to another property')).toBeTruthy();
  expect(screen.getByText('Cabin')).toBeTruthy();
});

test('confirming the move calls the mutation with the printer id and chosen destination', () => {
  renderWith(makePrinter({ id: 7, name: 'Garage Pi' }), [
    makeProperty({ id: 1, role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Move Garage Pi to Cabin?')).toBeTruthy();
  expect(within(dialog).getByText(/saved key/i)).toBeTruthy();
  expect(moveMutation.mutate).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(moveMutation.mutate).toHaveBeenCalledTimes(1);
  expect(moveMutation.mutate.mock.calls[0][0]).toEqual({ id: 7, toPropertyId: 2 });
});

test('onMoved fires with the destination id on a successful move', () => {
  const onMoved = vi.fn();
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess());
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 1, role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ], 1, onMoved);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(onMoved).toHaveBeenCalledWith(2);
});

test('an error (e.g. 409 destination already has a printer) toasts the message, and does not call onMoved', async () => {
  const { toast } = await import('@/components/ui/toast');
  const onMoved = vi.fn();
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onError(new Error('That property already has a printer')));
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 1, role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ], 1, onMoved);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(toast).toHaveBeenCalledWith('That property already has a printer');
  expect(onMoved).not.toHaveBeenCalled();
});
