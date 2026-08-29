// @vitest-environment jsdom
/**
 * Driven regression test for IMPORTANT 2 (the match kill switch) as fixed
 * by the whole-branch review's second pass.
 *
 * The first pass gated the "Finding this product" chip on `matchAvailable`
 * (canMatch) but left commit()'s own condition reading only
 * `vision.confidence === 'high' && vision.brand` — so with
 * MATCH_ENABLED=false, an ordinary branded capture still POSTed to
 * /api/products/_y_/matches, got the route's 503, and fired the new
 * onError toast on every single capture. This test renders the real
 * Capture page, drives an actual photo → identify-photo → name it → place
 * it → commit sequence with the server reporting matchAvailable:false, and
 * asserts no POST to the matches endpoint happens and no error toast fires.
 *
 * Camera-dependent children (scanner components, DestinationPicker) are
 * stubbed — they need real device APIs jsdom does not provide — but the
 * capture page itself, its state machine, and its network calls are real.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '@/components/ui/toast';
import { Capture } from './capture';

// vi.mock calls are hoisted above every import in this file by vitest's
// transform, so Capture (imported above, for readability) still picks up
// every one of these stubs regardless of source order.
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

/** Builds the fetch stub. `matchAvailable` mirrors what the server reports. */
function makeFetchMock(matchAvailable: boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({
        success: true,
        data: {
          available: true,
          matchAvailable,
          suggestion: {
            name: 'DeWalt Drill', description: null, category: 'tool', brand: 'DeWalt',
            quantity: null, estimatedValue: null, confidence: 'high',
          },
        },
      });
    }
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: { id: 101, name: 'DeWalt Drill', qrCode: 'TLY-I-abc123' } } });
    }
    if (url.includes('/api/products/_y_/matches')) {
      // Exactly what the real route does with MATCH_ENABLED=false — the
      // fetch stub still answers if the fix regresses, rather than crashing
      // the test outright, so the assertion below is what actually catches it.
      return jsonResponse({ success: false, message: 'Product matching is disabled' }, 503);
    }
    // File upload and any background cache-invalidation refetches.
    return jsonResponse({ success: true, data: {} });
  });
}

beforeEach(() => {
  // downscale() always calls this; jsdom has no canvas/bitmap decoder. The
  // catch(() => null) path makes it fall back to the original file, which is
  // all this test needs.
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  // useLayoutMode reads this; jsdom has no implementation at all. false =>
  // 'touch' chrome, the real phone flow (PICTURE -> SCAN -> SCAN -> DONE)
  // this regression lives in.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Photo -> identify-photo -> name it -> place it -> commit, all driven for
 * real. `checkStep2` runs right after identify-photo resolves and before
 * Next is clicked — the only moment step 2's chip-vs-scanner choice is
 * actually on screen.
 */
async function driveABrandedCaptureToCommit(
  fetchMock: ReturnType<typeof makeFetchMock>, checkStep2: () => void,
) {
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo] } });

  // identify-photo is fired unawaited (void identifyPhoto(blob)) — wait for
  // its answer to land rather than for any fixed UI text, since the whole
  // point of this test is that the UI must NOT show the match chip.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/products/_y_/identify-photo'), expect.anything(),
  ));
  await waitFor(() => expect(screen.queryByDisplayValue('DeWalt Drill')).toBeTruthy());

  // Step 2, as rendered right now — before Next is ever clicked — is the
  // moment `checkStep2` needs to inspect: canMatch decides what fills this
  // screen, and once we move past it the chip vs. scanner distinction is
  // gone from the DOM either way.
  checkStep2();

  const nextButton = screen.getByRole('button', { name: /next/i });
  fireEvent.click(nextButton);

  const pickBinButton = await screen.findByRole('button', { name: /pick a bin from the list/i });
  fireEvent.click(pickBinButton);

  const mockPick = await screen.findByRole('button', { name: 'mock-pick-bin' });
  fireEvent.click(mockPick);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/items/_y_/create'), expect.anything(),
  ));
}

test('MATCH_ENABLED=false: a branded capture shows the barcode step, fires no matches POST, and raises no toast', async () => {
  const fetchMock = makeFetchMock(false);
  await driveABrandedCaptureToCommit(fetchMock, () => {
    // Check 1 — the chip never replaced the barcode step. canMatch requires
    // matchAvailable, so with it false the ordinary ProductScanner renders.
    expect(screen.getByTestId('product-scanner')).toBeTruthy();
    expect(screen.queryByText(/finding this product/i)).toBeNull();
  });

  // Give any stray microtask (a mistakenly-fired mutation) a turn to run.
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Check 2 — the actual regression: commit()'s own gate must also read
  // matchAvailable, or the POST fires anyway right after step 2 was hidden.
  const matchCalls = fetchMock.mock.calls.filter(([url]) => (
    typeof url === 'string' && url.includes('/api/products/_y_/matches')
  ));
  expect(matchCalls).toHaveLength(0);

  // Check 3 — consequently, the queue-failure toast (fix 3) must never fire
  // for a capture the kill switch was supposed to leave untouched.
  expect(toast.error).not.toHaveBeenCalled();
});

test('sanity check: with the flag true, the same capture shows the chip and DOES queue a match', async () => {
  // Proves the rig actually detects both halves of the gate — without this,
  // the negative test above could pass vacuously (e.g. if commit() were
  // never reached, or if the chip check were silently wrong).
  const fetchMock = makeFetchMock(true);
  await driveABrandedCaptureToCommit(fetchMock, () => {
    expect(screen.getByText(/finding this product/i)).toBeTruthy();
    expect(screen.queryByTestId('product-scanner')).toBeNull();
  });

  await waitFor(() => {
    const matchCalls = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/products/_y_/matches')
    ));
    expect(matchCalls).toHaveLength(1);
  });
});
