// @vitest-environment jsdom
/**
 * Driven regression tests for the identify-photo generation guard (#233).
 *
 * identifyPhoto fires unawaited when a photo is accepted, and the commit is
 * optimistic — so a slow vision response for item A can resolve after the user
 * committed A and is already photographing item B. The commit-time direction
 * was already snapshot-protected (capture.optimistic.test.tsx (d)); this file
 * pins the DRAFT-application direction: a response may apply its name and
 * suggestions only while the draft it was asked about is still the live one.
 *
 * The contract under test:
 *
 *   (a) camera flow: identify for photo A resolving AFTER commit(A) + photo B
 *       touches nothing of B's draft — no pre-filled name, no unconfirmed
 *       dashed styling, no review link — and does not clear B's own
 *       still-pending "looking at it…" indicator
 *   (b) a same-generation resolve still applies: name lands, marked
 *       unconfirmed — the guard must not over-block the ordinary case
 *   (c) ManualCreate's dropped-photo path goes through the same shared guard:
 *       identify resolving after the form's optimistic submit leaves the next
 *       (cleared) form untouched
 *
 * Mocking follows capture.optimistic.test.tsx: camera-dependent children are
 * stubbed, the page and its network calls are real, and identify-photo is a
 * deferred promise the test body resolves by hand.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
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

/** A promise resolved from the test body — the deferred idiom. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A branded HIGH-confidence identify answer — the most assertive kind the
 *  model can give, so the kind a missing guard would apply most visibly. */
function suggestionResponse(name: string, brand: string): Response {
  return jsonResponse({
    success: true,
    data: {
      available: true, matchAvailable: true,
      suggestion: {
        name, brand, description: `a ${name.toLowerCase()}`, category: 'tool',
        quantity: null, estimatedValue: null, confidence: 'high',
      },
    },
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(path));
}

/** identify-photo answers from per-call gates; everything else succeeds. */
function makeGatedIdentifyMock(gates: { promise: Promise<Response> }[]) {
  let identifyCalls = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      const gate = gates[identifyCalls];
      identifyCalls += 1;
      return gate.promise;
    }
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: { id: 101, name: 'Untitled item', qrCode: 'TLY-I-abc123' } } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

function renderCapture(fetchMock: ReturnType<typeof vi.fn>, opts: { desk?: boolean } = {}) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: opts.desk ? query === SIDEBAR_QUERY : false,
    media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('(a) identify for photo A resolving after commit + photo B leaves B\'s draft untouched', async () => {
  const gates = [deferred<Response>(), deferred<Response>()];
  const fetchMock = makeGatedIdentifyMock(gates);
  const { container } = renderCapture(fetchMock);

  // Item A: photo in via the hoisted OS input — identify #1 fires and is held.
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File([JPEG_BYTES], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByPlaceholderText('Name it, or search…');
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(1));

  // Commit A on the photo alone (the photo identifies it; commit names it).
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'mock-pick-bin' }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));

  // Item B's photo goes in; identify #2 fires and is ALSO held — B's draft is
  // live and its "looking at it…" indicator is up.
  fireEvent.change(fileInput, { target: { files: [new File([JPEG_BYTES], 'b.jpg', { type: 'image/jpeg' })] } });
  const nameInput = await screen.findByPlaceholderText('Name it, or search…');
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(2));
  expect(screen.getByText(/photo held — looking at it/i)).toBeTruthy();

  // Only NOW does item A's identify answer arrive — a generation too late.
  gates[0].resolve(suggestionResponse('DeWalt Drill', 'DeWalt'));
  await new Promise((r) => setTimeout(r, 25));

  // B's draft is untouched: no pre-filled name, no unconfirmed styling, no
  // review link, no product-match chip — and B's own pending indicator is
  // still up (A's settle must not clear it).
  expect(screen.queryByDisplayValue('DeWalt Drill')).toBeNull();
  expect((nameInput as HTMLInputElement).value).toBe('');
  expect(nameInput.className).not.toContain('border-dashed');
  expect(screen.queryByRole('button', { name: /review what it found/i })).toBeNull();
  expect(screen.queryByText(/finding this product/i)).toBeNull();
  expect(screen.getByText(/photo held — looking at it/i)).toBeTruthy();

  // B's OWN answer still applies in full — the guard blocks generations, not
  // the feature. (Had A's stale name landed above, this would fail too: the
  // name field would no longer be empty, so B's applyName would be refused.)
  gates[1].resolve(suggestionResponse('Makita Saw', 'Makita'));
  await waitFor(() => expect(screen.getByDisplayValue('Makita Saw')).toBeTruthy());
  expect(screen.getByDisplayValue('Makita Saw').className).toContain('border-dashed');
});

test('(b) a same-generation resolve still applies: name lands, marked unconfirmed', async () => {
  const gates = [deferred<Response>()];
  const fetchMock = makeGatedIdentifyMock(gates);
  const { container } = renderCapture(fetchMock);

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File([JPEG_BYTES], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByPlaceholderText('Name it, or search…');
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(1));
  expect(screen.getByText(/photo held — looking at it/i)).toBeTruthy();

  // The draft it was asked about is still the live one — the answer applies.
  gates[0].resolve(suggestionResponse('DeWalt Drill', 'DeWalt'));
  const name = await screen.findByDisplayValue('DeWalt Drill');
  expect(name.className).toContain('border-dashed');
  // …and the pending indicator settles into the confidence line.
  expect(screen.getByText(/read from the photo/i)).toBeTruthy();
  expect(screen.queryByText(/photo held — looking at it/i)).toBeNull();
});

test('(c) ManualCreate\'s dropped photo goes through the same guard: a post-submit resolve leaves the cleared form untouched', async () => {
  // A remembered bin so the form is submittable without driving the picker.
  localStorage.setItem('tally-last-container', JSON.stringify([{ id: 42, name: 'Test Bin', areaId: 7 }]));
  const gates = [deferred<Response>()];
  const fetchMock = makeGatedIdentifyMock(gates);
  renderCapture(fetchMock, { desk: true });

  // Drop item A's photo on the desk form — the shared acceptPhotoFile path —
  // and identify #1 fires and is held.
  const dropTarget = screen.getByRole('button', { name: /drop one here, or choose a file/i });
  fireEvent.drop(dropTarget, { dataTransfer: { files: [new File([JPEG_BYTES], 'a.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(1));

  // Name it and submit. The commit is optimistic: the form clears
  // synchronously and the next item's (empty) draft is now the live one.
  const name = screen.getByPlaceholderText('Cordless drill');
  fireEvent.change(name, { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await waitFor(() => expect((name as HTMLInputElement).value).toBe(''));

  // A's identify answer arrives only now — after its item was committed.
  gates[0].resolve(suggestionResponse('DeWalt Drill', 'DeWalt'));
  await new Promise((r) => setTimeout(r, 25));

  // The cleared form belongs to the NEXT item: nothing may land in it.
  expect((name as HTMLInputElement).value).toBe('');
  expect(name.className).not.toContain('border-dashed');
  expect(screen.queryByDisplayValue('DeWalt Drill')).toBeNull();
  expect(screen.queryByRole('button', { name: /review what it found/i })).toBeNull();
});
