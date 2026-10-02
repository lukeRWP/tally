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
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess({ id: 7, propertyId: 2, requeued: 0, released: 0, held: 0, fromPropertyId: 1, leftBehind: 0 }));
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

test('a clean move (nothing left behind) toasts the simple "Moved to X" message', async () => {
  const { toast } = await import('@/components/ui/toast');
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess({ id: 7, propertyId: 2, requeued: 0, released: 0, held: 0, fromPropertyId: 1, leftBehind: 0 }));
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 1, name: 'House', role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(toast).toHaveBeenCalledWith('Moved to Cabin');
});

test('a move that strands jobs toasts the count and the source property name, singular', async () => {
  const { toast } = await import('@/components/ui/toast');
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess({ id: 7, propertyId: 2, requeued: 1, released: 0, held: 0, fromPropertyId: 1, leftBehind: 1 }));
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 1, name: 'House', role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(toast).toHaveBeenCalledWith(
    "Moved to Cabin — 1 job left at House won't print until a printer is added there");
});

test('a move that strands jobs toasts the count, plural, falling back to "the old property" when the source name is unknown', async () => {
  const { toast } = await import('@/components/ui/toast');
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess({ id: 7, propertyId: 2, requeued: 3, released: 0, held: 0, fromPropertyId: 1, leftBehind: 3 }));
  // Only the destination is in the properties list — the source (id 1) isn't,
  // so the toast must fall back rather than throw or say "undefined".
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

  expect(toast).toHaveBeenCalledWith(
    "Moved to Cabin — 3 jobs left at the old property won't print until a printer is added there");
});

test('the confirm dialog describes jobs staying at (and not printing at) the source property, not implying they will print', () => {
  renderWith(makePrinter({ id: 7 }), [
    makeProperty({ id: 1, name: 'House', role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ]);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(
    /Jobs waiting at House stay with House and won't print until a printer is added there/))
    .toBeTruthy();
});

test('after a successful move, the move state is reset — rerendering at the new property leaves Move disabled and no dialog open', () => {
  const onMoved = vi.fn();
  moveMutation.mutate = vi.fn((_vars, opts) => opts.onSuccess({ id: 7, propertyId: 2, requeued: 0, released: 0, held: 0, fromPropertyId: 1, leftBehind: 0 }));
  const properties = [
    makeProperty({ id: 1, name: 'House', role: 'owner' }),
    makeProperty({ id: 2, name: 'Cabin', role: 'owner' }),
  ];
  const { rerender } = renderWith(makePrinter({ id: 7, propertyId: 1 }), properties, 1, onMoved);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' }));
  expect(onMoved).toHaveBeenCalledWith(2);

  // The printer really did move to Cabin (propertyId 2); House (id 1) is now
  // a legal destination from Cabin's side, so the move section still renders
  // — this is the component instance settings.tsx's `key={selectedPropertyId}`
  // exists to avoid reusing, simulated here as a rerender at the new
  // propertyId on the SAME instance to prove the internal gating (not just
  // the remount) holds.
  vi.mocked(usePrinters).mockReturnValue({ data: [makePrinter({ id: 7, propertyId: 2 })] } as unknown as ReturnType<typeof usePrinters>);
  vi.mocked(useProperties).mockReturnValue({ data: properties } as unknown as ReturnType<typeof useProperties>);
  rerender(<PrinterSettings propertyId={2} onMoved={onMoved} />);

  expect(screen.getByRole('button', { name: 'Move' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
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
