// @vitest-environment jsdom
/**
 * A quota rejection must not read as "couldn't read it".
 *
 * Vision is capped per USER, not per device — 20/min and 250/day in
 * `products.routes.js`, keyed by `perUser`. So a 429 lands on every device the
 * account is signed into at once, which is indistinguishable, from the user's
 * side, from the server being broken. That is exactly how it was read on
 * 2026-08-30: "AI photos aren't working", on two devices, no error anywhere.
 *
 * The two states have opposite remedies, which is why one message cannot serve
 * both. A failure to read is fixed by retaking the photo. A quota rejection is
 * fixed by waiting — and retaking only spends another attempt against the same
 * cap, making it worse.
 *
 * Setup mirrors capture.kill-switch.test.tsx: camera-dependent children are
 * stubbed, the page and its fetches are real.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Capture } from './capture';

vi.mock('@/components/scanner/product-scanner', () => ({
  ProductScanner: () => <div data-testid="product-scanner">barcode scanner</div>,
}));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner">tag scanner</div>,
}));
vi.mock('@/components/scanner/product-search', () => ({
  ProductSearch: () => <div data-testid="product-search" />,
}));
vi.mock('@/components/scanner/url-extractor', () => ({
  UrlExtractor: () => <div data-testid="url-extractor" />,
}));
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: () => <div data-testid="destination-picker" />,
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fetch stub whose identify-photo answer is the thing under test. */
function fetchWithIdentifyStatus(status: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return new Response(JSON.stringify({ success: false, message: 'nope' }),
        { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

async function captureAPhoto(status: number) {
  const fetchMock = fetchWithIdentifyStatus(status);
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Capture /></MemoryRouter>
    </QueryClientProvider>,
  );
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo] } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/products/_y_/identify-photo'), expect.anything(),
  ));
  return fetchMock;
}

test('a 429 says the naming limit was reached, not that the photo was unreadable', async () => {
  await captureAPhoto(429);
  await waitFor(() => expect(screen.getByText(/naming limit reached/i)).toBeTruthy());
  expect(screen.queryByText(/couldn't read it/i)).toBeNull();
});

test('a 500 still says the photo could not be read', async () => {
  await captureAPhoto(500);
  await waitFor(() => expect(screen.getByText(/couldn't read it/i)).toBeTruthy());
  expect(screen.queryByText(/naming limit reached/i)).toBeNull();
});
