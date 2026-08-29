// @vitest-environment jsdom
/**
 * #204 — "Offline" alone hides how long the agent has been gone. The badge
 * must carry the age of the last contact ("Offline · last seen 3h ago") using
 * the same relative-time idiom as activity/notifications. Mocking follows
 * label-print-dialog.test.tsx: the data hooks are mocked directly, so no
 * QueryClientProvider or network is needed.
 */
import { render, screen } from '@testing-library/react';
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

const mutation = { mutate: vi.fn(), isPending: false };

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
  const hooks = vi.mocked(await import('@/hooks/use-print'));
  for (const h of [hooks.useCreatePrinter, hooks.useRevokePrinter, hooks.useSetLoadedMedia,
                   hooks.useCancelPrintJob, hooks.useRetryPrintJob]) {
    h.mockReturnValue(mutation as never);
  }
});

test('an offline printer row renders how long the agent has been gone', () => {
  renderWith(makePrinter({ lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
  expect(screen.getByText('Offline · last seen 3h ago')).toBeTruthy();
});

test('a printer seen within the last minute still reads Online, with no age', () => {
  renderWith(makePrinter({ lastSeenAt: new Date(Date.now() - 10_000).toISOString() }));
  expect(screen.getByText('Online')).toBeTruthy();
  expect(screen.queryByText(/last seen/)).toBeNull();
});

test('a printer that has never phoned home reads plain Offline — there is no age to show', () => {
  renderWith(makePrinter({ lastSeenAt: null }));
  expect(screen.getByText('Offline')).toBeTruthy();
});
