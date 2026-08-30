// @vitest-environment jsdom
/**
 * Capture's two finger-sized-target defects.
 *
 * #268 — the scanner's destructive `Close` sat 8px from the benign `Stop`,
 * both 32px, on a screen driven by a finger. Capture stops passing `onClose`
 * on a coarse pointer, so the control is not drawn there at all; a mouse still
 * gets it, because a cursor does not slip 8px.
 *
 * #273 — the completed-step dots, which are #229's only way back a step,
 * rendered 0x0. `dotClass` carries `h-[3px] w-8`, but for a PAST step the dot
 * is a <span> inside a plain block <button>, where it is an ordinary inline
 * child and width/height simply do not apply. The wrapper becomes a flex
 * container (blockifying the dot) with a finger-sized hit area.
 *
 * The dot assertion is on classes, not on measurements: jsdom does no layout
 * and this project's Tailwind classes are compiled by Vite, not by the test
 * DOM, so `getComputedStyle` would report the same thing before and after the
 * fix. The class IS the fix — an inline child of a block button is the whole
 * defect — so the class is what is pinned.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '@/components/ui/toast';
import { COARSE_QUERY } from '@/hooks/use-coarse-pointer';
import { Capture } from './capture';

/** Props each scanner was rendered with — #268 is about what capture passes. */
const { scannerProps } = vi.hoisted(() => ({
  scannerProps: [] as { onClose?: () => void }[],
}));

vi.mock('@/components/scanner/product-scanner', () => ({
  ProductScanner: (props: { onClose?: () => void }) => {
    scannerProps.push(props);
    return <div data-testid="product-scanner">barcode scanner</div>;
  },
}));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: (props: { onClose?: () => void }) => {
    scannerProps.push(props);
    return <div data-testid="tag-scanner">tag scanner</div>;
  },
}));
vi.mock('@/components/scanner/product-search', () => ({
  ProductSearch: () => <div data-testid="product-search" />,
}));
vi.mock('@/components/scanner/url-extractor', () => ({
  UrlExtractor: () => <div data-testid="url-extractor" />,
}));
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: ({ onPick }: { onPick: (b: { id: number; name: string; areaId: number }) => void }) => (
    <button type="button" onClick={() => onPick({ id: 42, name: 'Test Bin', areaId: 7 })}>
      mock-pick-bin
    </button>
  ),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Renders the three-step camera flow; `coarse` picks the pointer it is driven by. */
function renderFlow({ coarse }: { coarse: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: coarse && query === COARSE_QUERY, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({ success: true, data: { available: false, matchAvailable: false, suggestion: null } });
    }
    return jsonResponse({ success: true, data: {} });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  scannerProps.length = 0;
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  localStorage.clear();
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('#268 a coarse pointer is never handed the scanner\'s draft-discarding Close', async () => {
  renderFlow({ coarse: true });

  // Step 2 (the product scanner) and step 3 (the tag scanner) both.
  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));
  await screen.findByTestId('product-scanner');
  fireEvent.change(screen.getByPlaceholderText(/name it, or search/i), { target: { value: 'Cordless Drill' } });
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  await screen.findByTestId('tag-scanner');

  expect(scannerProps.length).toBeGreaterThanOrEqual(2);
  expect(scannerProps.every((p) => p.onClose === undefined)).toBe(true);
});

test('#268 a mouse still gets Close — the hazard is the finger, not the control', async () => {
  renderFlow({ coarse: false });

  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));
  await screen.findByTestId('product-scanner');

  expect(scannerProps.length).toBeGreaterThan(0);
  expect(scannerProps.every((p) => typeof p.onClose === 'function')).toBe(true);
});

test('#273 a completed-step dot is a flex container with a finger-sized hit area', async () => {
  renderFlow({ coarse: true });

  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));
  const back = await screen.findByRole('button', { name: /back to picture/i });

  // Blockified: the dot is a flex ITEM now, so its w-5/h-[3px] apply and the
  // completed step is visible at all.
  expect(back.className.split(/\s+/)).toContain('flex');
  // …and the target grew from 8x8 without displacing the row (negative margin).
  expect(back.className).toContain('p-2');
  expect(back.className).toContain('-m-2');
  expect(back.className).not.toContain('p-1');

  // Still #229's feature, unchanged: the dot is a real way back a step.
  const dot = back.querySelector('span');
  expect(dot?.className).toContain('w-5');   // a past dot's own width
  fireEvent.click(back);
  await waitFor(() => expect(screen.getByText('1/3')).toBeTruthy());
});
