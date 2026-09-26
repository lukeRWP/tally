// @vitest-environment jsdom
/**
 * Tally #388 / PW service-accounts plan phase 2 — the Settings pairing UI for
 * a pwiam service account, dual-accept alongside the legacy tp_ token flow.
 *
 * Mocking follows printer-settings.test.tsx: the data hooks are mocked
 * directly, so no QueryClientProvider or network is needed.
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
  useBindServiceAccount: vi.fn(),
  useUnbindServiceAccount: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const idleMutation = { mutate: vi.fn(), isPending: false };
const bindMutation = { mutate: vi.fn(), isPending: false };
const unbindMutation = { mutate: vi.fn(), isPending: false };

function makePrinter(overrides: Partial<Printer>): Printer {
  return {
    id: 1, propertyId: 1, name: 'Garage Pi', loadedMedia: 'small',
    printerState: 'idle', printerStateReasons: [], lastSeenAt: null,
    serviceAccountId: null,
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
  bindMutation.mutate = vi.fn();
  unbindMutation.mutate = vi.fn();
  const hooks = vi.mocked(await import('@/hooks/use-print'));
  for (const h of [hooks.useCreatePrinter, hooks.useRevokePrinter, hooks.useSetLoadedMedia,
                   hooks.useCancelPrintJob, hooks.useRetryPrintJob]) {
    h.mockReturnValue(idleMutation as never);
  }
  hooks.useBindServiceAccount.mockReturnValue(bindMutation as never);
  hooks.useUnbindServiceAccount.mockReturnValue(unbindMutation as never);
});

test('an unpaired printer shows the pairing field, not the paired badge', () => {
  renderWith(makePrinter({ serviceAccountId: null }));
  expect(screen.getByPlaceholderText('Service account ID (ULID)')).toBeTruthy();
  expect(screen.queryByText('Paired')).toBeNull();
});

test('pairing with a well-formed ULID calls bindServiceAccount with the trimmed id', () => {
  renderWith(makePrinter({ id: 7, serviceAccountId: null }));

  fireEvent.change(screen.getByPlaceholderText('Service account ID (ULID)'), { target: { value: `  ${VALID_ULID}  ` } });
  fireEvent.click(screen.getByRole('button', { name: 'Pair' }));

  expect(bindMutation.mutate).toHaveBeenCalledTimes(1);
  expect(bindMutation.mutate.mock.calls[0][0]).toEqual({ id: 7, serviceAccountId: VALID_ULID });
});

test('pairing with junk never calls the mutation', async () => {
  const { toast } = await import('@/components/ui/toast');
  renderWith(makePrinter({ serviceAccountId: null }));

  fireEvent.change(screen.getByPlaceholderText('Service account ID (ULID)'), { target: { value: 'not-a-ulid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pair' }));

  expect(bindMutation.mutate).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalled();
});

test('a paired printer shows the SA id and an Unpair control instead of the pairing field', () => {
  renderWith(makePrinter({ serviceAccountId: VALID_ULID }));
  expect(screen.getByText('Paired')).toBeTruthy();
  expect(screen.getByText(VALID_ULID)).toBeTruthy();
  expect(screen.queryByPlaceholderText('Service account ID (ULID)')).toBeNull();
});

test('unpairing calls unbindServiceAccount with the printer id', () => {
  renderWith(makePrinter({ id: 9, serviceAccountId: VALID_ULID }));
  fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
  expect(unbindMutation.mutate).toHaveBeenCalledTimes(1);
  expect(unbindMutation.mutate.mock.calls[0][0]).toBe(9);
});

test('the legacy add-printer flow is labelled legacy during dual-accept', () => {
  vi.mocked(usePrinters).mockReturnValue({ data: [] } as unknown as ReturnType<typeof usePrinters>);
  vi.mocked(usePrintJobs).mockReturnValue({ data: [] } as unknown as ReturnType<typeof usePrintJobs>);
  render(<PrinterSettings propertyId={1} />);
  expect(screen.getByText('Add printer (legacy)')).toBeTruthy();
});
