// @vitest-environment jsdom
/**
 * #227 — the print dialog must CLOSE on success. Before this, both the
 * Send-to-printer and Generate paths left the dialog open with a re-enabled
 * button, and a second tap double-fired duplicate physical labels. The
 * contract: each mutation's onSuccess calls onOpenChange(false) FIRST —
 * exactly as the Add-to-queue path always has — and a closed dialog has no
 * button left to double-fire.
 *
 * Mocking follows create-container-dialog.test.tsx: the data hooks are
 * mocked directly, so no QueryClientProvider or network is needed. The
 * mutations' onSuccess callbacks are invoked by hand from the captured
 * mutate() options — the success is the unit under test, not the request.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { LabelPrintDialog } from './label-print-dialog';
import { useGenerateLabels } from '@/hooks/use-labels';
import { usePrinters, useCreatePrintJob } from '@/hooks/use-print';
import { toast } from '@/components/ui/toast';

vi.mock('@/hooks/use-labels', () => ({
  useGenerateLabels: vi.fn(),
  useQrImageUrl: (code: string) => `/api/labels/_x_/qr/${code}`,
}));
vi.mock('@/hooks/use-print', () => ({
  usePrinters: vi.fn(),
  useCreatePrintJob: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});
// The preview fetches a QR image and measures itself — none of that is under
// test here, and jsdom has no layout to measure anyway.
vi.mock('./label-preview', () => ({
  LabelPreview: () => <div data-testid="label-preview" />,
}));

const ENTITY = { id: 7, name: 'Socket Set', qrCode: 'TLY-I-abc123', type: 'item' };

type MutateOptions<Res> = { onSuccess: (res: Res) => void; onError: (err: unknown) => void };

const printMutate = vi.fn();
const generateMutate = vi.fn();

function renderDialog(onOpenChange: (open: boolean) => void, isOpen = true) {
  return render(
    <LabelPrintDialog
      entities={[ENTITY]}
      entityType="item"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      propertyId={1}
    />,
  );
}

beforeEach(() => {
  printMutate.mockClear();
  generateMutate.mockClear();
  vi.mocked(toast).mockClear();
  localStorage.clear();
  vi.mocked(useCreatePrintJob).mockReturnValue({
    mutate: printMutate, isPending: false,
  } as unknown as ReturnType<typeof useCreatePrintJob>);
  vi.mocked(useGenerateLabels).mockReturnValue({
    mutate: generateMutate, isPending: false, reset: vi.fn(),
  } as unknown as ReturnType<typeof useGenerateLabels>);
  // Online (fresh lastSeenAt), healthy, and holding the small roll the item
  // preset defaults to — the state where "Send to printer" is clickable.
  vi.mocked(usePrinters).mockReturnValue({
    data: [{
      id: 1, name: 'Pi', lastSeenAt: new Date().toISOString(),
      printerState: 'idle', printerStateReasons: [], loadedMedia: 'small',
    }],
  } as unknown as ReturnType<typeof usePrinters>);
});

test('Send to printer: success closes the dialog before it toasts', () => {
  const onOpenChange = vi.fn();
  renderDialog(onOpenChange);

  fireEvent.click(screen.getByRole('button', { name: /send to printer/i }));
  expect(printMutate).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalled(); // not on click — on SUCCESS

  const opts = printMutate.mock.calls[0][1] as MutateOptions<{ id: number; status: string }>;
  opts.onSuccess({ id: 5, status: 'queued' });

  expect(onOpenChange).toHaveBeenCalledWith(false);
  // Close FIRST, then report: the toast outlives the dialog, so the user
  // reads the outcome over the page they are back on, not over a dialog
  // whose re-enabled button is the double-fire path this fix removes.
  expect(vi.mocked(toast)).toHaveBeenCalledWith('Printing 1 label');
  expect(onOpenChange.mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(toast).mock.invocationCallOrder[0]);
});

test('Send to printer: a held job still closes the dialog', () => {
  const onOpenChange = vi.fn();
  renderDialog(onOpenChange);

  fireEvent.click(screen.getByRole('button', { name: /send to printer/i }));
  const opts = printMutate.mock.calls[0][1] as MutateOptions<{ id: number; status: string }>;
  opts.onSuccess({ id: 6, status: 'held' });

  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(vi.mocked(toast)).toHaveBeenCalledWith('Queued — will print when you load the small roll');
});

test('Generate: PDF success closes the dialog before it toasts', () => {
  const onOpenChange = vi.fn();
  renderDialog(onOpenChange);

  fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));
  expect(generateMutate).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalled();

  const opts = generateMutate.mock.calls[0][1] as MutateOptions<void>;
  opts.onSuccess(undefined);

  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(vi.mocked(toast)).toHaveBeenCalledWith('PDF downloaded');
  expect(onOpenChange.mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(toast).mock.invocationCallOrder[0]);
});

test('a failure leaves the dialog open for a retry', () => {
  const onOpenChange = vi.fn();
  renderDialog(onOpenChange);

  fireEvent.click(screen.getByRole('button', { name: /send to printer/i }));
  const opts = printMutate.mock.calls[0][1] as MutateOptions<{ id: number; status: string }>;
  opts.onError(new Error('agent offline'));

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(vi.mocked(toast)).toHaveBeenCalledWith('agent offline');
});

test('once closed, no print or generate button remains to double-fire', () => {
  const onOpenChange = vi.fn();
  const { rerender } = renderDialog(onOpenChange);
  expect(screen.getByRole('button', { name: /send to printer/i })).toBeTruthy();

  // The parent owns `isOpen`; onOpenChange(false) lands here as a re-render
  // with the dialog closed — Radix unmounts the content, buttons and all.
  rerender(
    <LabelPrintDialog
      entities={[ENTITY]}
      entityType="item"
      isOpen={false}
      onOpenChange={onOpenChange}
      propertyId={1}
    />,
  );

  expect(screen.queryByRole('button', { name: /send to printer/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^generate$/i })).toBeNull();
});
