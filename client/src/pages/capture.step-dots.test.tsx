// @vitest-environment jsdom
/**
 * Driven regression tests for the progress-dot back control (#229a, task-4
 * brief). The three dots used to be pure display (static <span>s) — this
 * makes a dot for a step BEHIND the current one a real button:
 *
 *   place (3) -> identify (2): keeps the draft AND the photo.
 *   identify (2) -> photo (1): keeps the photo too — the photo area itself,
 *     not this dot, is the retake affordance.
 *   the current dot and any dot AHEAD of it stay inert (no button at all) —
 *     this is a way back, not a way to skip ahead.
 *
 * Phase transitions only ever call setPhase with one of the three already-
 * valid Phase values — no new state is introduced.
 *
 * Mocking follows capture.kill-switch.test.tsx / capture.manual.test.tsx:
 * camera-dependent children are stubbed, the page and its phase state are
 * real. The desk-mode test reuses capture.manual.test.tsx's matchMedia
 * pattern (SIDEBAR_QUERY matches, coarse doesn't) to reach showForm===true.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '@/components/ui/toast';
import { SIDEBAR_QUERY } from '@/hooks/use-layout-mode';
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

/** Only identify-photo gets a shaped answer; everything else is empty-success. */
function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({ success: true, data: { available: false, matchAvailable: false, suggestion: null } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

function renderTouch() {
  vi.stubGlobal('fetch', makeFetchMock());
  // Every matchMedia query fails: a phone, not a desk with a sidebar or a
  // coarse-pointer tablet — the real three-step camera flow this feature
  // lives in (same as capture.kill-switch.test.tsx).
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

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
  // downscale() always calls this; jsdom has no canvas/bitmap decoder — the
  // catch(() => null) fallback path just keeps the original file.
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  localStorage.clear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function takeAPhoto(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo] } });
}

test('step-1 dot: identify -> photo keeps the photo', async () => {
  const { container } = renderTouch();

  takeAPhoto(container);

  // acceptPhotoFile sets phase 'identify' before the (unawaited) vision
  // call — the back-to-picture dot appearing is the step-1-behind signal.
  await waitFor(() => expect(screen.getByRole('button', { name: /back to picture/i })).toBeTruthy());
  expect(container.querySelector('img[src="blob:mock"]')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /back to picture/i }));

  await waitFor(() => expect(screen.getByText('1/3')).toBeTruthy());
  // The dot's own job is done, not a retake — the photo the flow already
  // has stays in the draft.
  expect(container.querySelector('img[src="blob:mock"]')).toBeTruthy();
  // Back on step 1: there is no step behind it to go to.
  expect(screen.queryByRole('button', { name: /back to /i })).toBeNull();
});

test('step-2 dot: place -> identify keeps the draft and the photo', async () => {
  const { container } = renderTouch();

  takeAPhoto(container);
  await waitFor(() => expect(screen.getByRole('button', { name: /back to picture/i })).toBeTruthy());

  const nameField = screen.getByPlaceholderText(/name it, or search/i) as HTMLInputElement;
  fireEvent.change(nameField, { target: { value: 'Cordless Drill' } });

  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /pick a bin from the list/i })).toBeTruthy());

  const backToIdentify = screen.getByRole('button', { name: /back to identify/i });
  fireEvent.click(backToIdentify);

  await waitFor(() => expect(
    (screen.getByPlaceholderText(/name it, or search/i) as HTMLInputElement).value,
  ).toBe('Cordless Drill'));
  expect(container.querySelector('img[src="blob:mock"]')).toBeTruthy();
});

test('the current step and any step ahead of it are never buttons', async () => {
  renderTouch();

  // Step 1 (photo): nothing behind it to go back to.
  expect(screen.queryByRole('button', { name: /back to /i })).toBeNull();

  // No photo needed to reach step 2 — the phone flow's own escape hatch.
  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));

  await waitFor(() => expect(screen.getByRole('button', { name: /back to picture/i })).toBeTruthy());
  // The current dot (identify) and the one ahead (place) stay inert.
  expect(screen.queryByRole('button', { name: /back to identify/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /back to place/i })).toBeNull();
});

test('typed/desk mode: the dots still render (hidden via CSS), and the same back-nav rules apply', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  // A fine-pointer desk: the sidebar layout query matches, the coarse-pointer
  // query does not — showForm === true, ManualCreate renders (capture.manual
  // .test.tsx's pattern).
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === SIDEBAR_QUERY, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  // ManualCreate shares the SAME hidden file input and the SAME
  // acceptPhotoFile entry point as the camera flow — it still calls
  // setPhase('identify') even though the desk form never reads `phase`.
  takeAPhoto(container);

  await waitFor(() => expect(screen.getByRole('button', { name: /back to picture/i })).toBeTruthy());

  // The progress row is visually hidden in this mode (Tailwind's `hidden`
  // class on its container) — proving the dots are the SAME markup taking a
  // CSS detour, not a separate (untested) code path for showForm.
  const backButton = screen.getByRole('button', { name: /back to picture/i });
  expect(backButton.closest('.hidden')).toBeTruthy();

  // Same rules regardless of visibility: still just setPhase to an
  // already-valid phase, still keeps the photo.
  fireEvent.click(backButton);
  expect(container.querySelector('img[src="blob:mock"]')).toBeTruthy();
});
