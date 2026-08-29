// @vitest-environment jsdom
/**
 * Driven regression tests for the optimistic capture commit (#223).
 *
 * The contract under test: commit() must return the flow to scan-ready
 * SYNCHRONOUSLY — the phone user is aiming at the next item while the network
 * works — and everything that used to happen after the create round trip now
 * reconciles through the session receipt instead:
 *
 *   (a) after commit the flow is scan-ready BEFORE the create promise resolves
 *   (b) the receipt appears immediately as pending and patches to saved with
 *       the real id when the create resolves
 *   (c) a rejected create flips the receipt to failed, toasts naming the item,
 *       and Retry re-fires the create with the byte-identical payload
 *   (d) the product-match queue fires with the vision snapshot taken at commit
 *       time even when the NEXT item's photo has already overwritten the live
 *       vision state — the known race this design exists to close
 *   (e) a failed photo upload marks the receipt `photo failed · retry`, and
 *       the retry re-uploads from the snapshot's blob
 *   (f) receipts render newest first — the just-committed (and possibly
 *       failing) row must sit above the fold of an unbounded list — and a
 *       state patch lands in place, never reordering the rows
 *
 * #227 adds instant-commit safety on top of the same receipt machinery:
 *
 *   (g) the create-success toast carries an Undo action that soft-deletes
 *       the created item (DELETE /api/items/_d_/<id> — the recycle-bin
 *       path) and flips THAT receipt to its terminal `undone` state:
 *       struck-through row, no Retry, no label actions
 *   (h) Undo is single-shot — a second invoke is a no-op (no second DELETE)
 *   (i) each toast's Undo closes over its own receipt: undoing receipt A
 *       while receipt B is still pending touches only A
 *
 * Mocking follows capture.kill-switch.test.tsx: camera-dependent children are
 * stubbed, the page and its network calls are real, and the create endpoint is
 * a deferred promise the test body resolves by hand.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '@/components/ui/toast';
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

/** A promise resolved from the test body — the deferred-create idiom. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const CREATED_ITEM = { id: 101, name: 'Socket Set', qrCode: 'TLY-I-abc123' };

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(path));
}

function renderCapture(fetchMock: ReturnType<typeof vi.fn>) {
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

/** Skip the photo, type a name, advance, and land the item in the mock bin. */
async function driveTypedCommit(name = 'Socket Set') {
  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));
  const nameInput = await screen.findByPlaceholderText('Name it, or search…');
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'mock-pick-bin' }));
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
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

test('(a) the flow is scan-ready before the create promise resolves', async () => {
  const createGate = deferred<Response>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) return createGate.promise;
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);
  await driveTypedCommit();

  // The create POST has fired…
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));

  // …and WITHOUT resolving it, step 1 is already back and the draft is gone.
  expect(screen.getByRole('button', { name: /take a photo of the item/i })).toBeTruthy();
  expect(screen.queryByDisplayValue('Socket Set')).toBeNull();
  expect(screen.queryByPlaceholderText('Name it, or search…')).toBeNull();

  // The receipt is on screen as pending while the network still works.
  expect(screen.getByText('Socket Set')).toBeTruthy();
  expect(screen.getByText(/saving/i)).toBeTruthy();

  // Only now let the network finish, so the test doesn't leak a pending patch.
  createGate.resolve(jsonResponse({ success: true, data: { item: CREATED_ITEM } }));
  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());
});

test('(b) the receipt appears as pending and patches to saved with the real id on resolve', async () => {
  const createGate = deferred<Response>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) return createGate.promise;
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);
  await driveTypedCommit();

  await waitFor(() => expect(screen.getByText(/saving/i)).toBeTruthy());
  // Pending: no server row yet, so no label actions and no qr code.
  expect(screen.queryByText(/TLY-I-abc123/)).toBeNull();
  expect(screen.queryByRole('button', { name: /^queue$/i })).toBeNull();

  createGate.resolve(jsonResponse({ success: true, data: { item: CREATED_ITEM } }));

  // Saved: the same row (same name) now carries the server identity.
  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());
  expect(screen.queryByText(/saving/i)).toBeNull();
  expect(screen.getByRole('button', { name: /^queue$/i })).toBeTruthy();
  // #227: the success toast now carries the Undo action alongside the message.
  expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
    'Socket Set → Test Bin',
    expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
  );
});

test('(c) a rejected create flips the receipt to failed and Retry re-fires the same payload', async () => {
  let createCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) {
      createCalls += 1;
      return createCalls === 1
        ? jsonResponse({ success: false, message: 'db exploded' }, 500)
        : jsonResponse({ success: true, data: { item: CREATED_ITEM } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);
  await driveTypedCommit();

  // Failed state, named toast, and the flow still scan-ready.
  const retry = await screen.findByRole('button', { name: /^retry$/i });
  expect(screen.getByText(/not saved/i)).toBeTruthy();
  expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Couldn\'t save "Socket Set" — Retry from the list');
  expect(screen.getByRole('button', { name: /take a photo of the item/i })).toBeTruthy();

  fireEvent.click(retry);

  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(2));
  const [first, second] = callsTo(fetchMock, '/api/items/_y_/create');
  // The retry runs from the snapshot stored on the receipt — the live draft
  // was reset long ago — so the request body must be byte-identical.
  expect((second[1] as RequestInit).body).toEqual((first[1] as RequestInit).body);

  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());
  expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
});

test('(d) queueMatch fires with the vision snapshot from commit time, not the live state', async () => {
  const createGate = deferred<Response>();
  let identifyCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      identifyCalls += 1;
      const suggestion = identifyCalls === 1
        ? { name: 'DeWalt Drill', description: 'a drill', category: 'tool', brand: 'DeWalt',
            quantity: null, estimatedValue: null, confidence: 'high' }
        : { name: 'Makita Saw', description: 'a saw', category: 'tool', brand: 'Makita',
            quantity: null, estimatedValue: null, confidence: 'high' };
      return jsonResponse({ success: true, data: { available: true, matchAvailable: true, suggestion } });
    }
    if (url.includes('/api/items/_y_/create')) return createGate.promise;
    return jsonResponse({ success: true, data: {} });
  });
  const { container } = renderCapture(fetchMock);

  // Item 1: photo → branded high-confidence suggestion → chip replaces step 2.
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const photo1 = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p1.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo1] } });
  await waitFor(() => expect(screen.queryByDisplayValue('DeWalt Drill')).toBeTruthy());
  expect(screen.getByText(/finding this product/i)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'mock-pick-bin' }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));

  // Item 2's photo lands while item 1's create is STILL in flight, and its
  // suggestion overwrites the live vision state — the race under test.
  const photo2 = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1])], 'p2.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo2] } });
  await waitFor(() => expect(screen.queryByDisplayValue('Makita Saw')).toBeTruthy());

  // Only now does item 1's create resolve.
  createGate.resolve(jsonResponse({ success: true, data: { item: { id: 101, name: 'DeWalt Drill', qrCode: 'TLY-I-abc123' } } }));

  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/matches')).toHaveLength(1));
  const [, init] = callsTo(fetchMock, '/api/products/_y_/matches')[0];
  const body = JSON.parse((init as RequestInit).body as string);
  // The payload is the snapshot taken at commit time — pre-change values.
  expect(body).toMatchObject({ itemId: 101, brand: 'DeWalt', name: 'DeWalt Drill' });
  expect(body.brand).not.toBe('Makita');
});

test('(e) a failed photo upload marks the receipt and its retry re-uploads from the snapshot', async () => {
  let uploadCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({ success: true, data: { available: false, matchAvailable: false, suggestion: null } });
    }
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: CREATED_ITEM } });
    }
    if (url.includes('/api/files/_y_/item/101/upload')) {
      uploadCalls += 1;
      return uploadCalls === 1
        ? jsonResponse({ success: false, message: 'minio down' }, 500)
        : jsonResponse({ success: true, data: {} });
    }
    return jsonResponse({ success: true, data: {} });
  });
  const { container } = renderCapture(fetchMock);

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo] } });
  const nameInput = await screen.findByPlaceholderText('Name it, or search…');
  fireEvent.change(nameInput, { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'mock-pick-bin' }));

  // The item saved; only the photo failed — the receipt says exactly that.
  const photoRetry = await screen.findByRole('button', { name: /photo failed · retry/i });
  expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy();

  fireEvent.click(photoRetry);
  await waitFor(() => expect(callsTo(fetchMock, '/api/files/_y_/item/101/upload')).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: /photo failed · retry/i })).toBeNull());
});

/** The options object of the FIRST toast.success call whose message starts
 *  with `name` — where the Undo action for that item's commit lives. */
function undoActionFor(name: string) {
  const call = vi.mocked(toast.success).mock.calls.find(
    ([msg]) => typeof msg === 'string' && msg.startsWith(`${name} →`),
  );
  expect(call).toBeTruthy();
  return (call![1] as unknown as { action: { label: string; onClick: () => void } }).action;
}

test('(g) the success toast\'s Undo soft-deletes the item and retires the receipt', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: CREATED_ITEM } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);
  await driveTypedCommit();
  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());

  const action = undoActionFor('Socket Set');
  expect(action.label).toBe('Undo');

  action.onClick();

  // The soft-delete fires against the id the toast's closure captured —
  // this is the recycle-bin path, so the mis-filed item stays restorable.
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_d_/101')).toHaveLength(1));
  const [, init] = callsTo(fetchMock, '/api/items/_d_/101')[0];
  expect((init as RequestInit).method).toBe('DELETE');

  // Terminal receipt: the row stays (struck through) so the session list
  // still accounts for the scan, but nothing on it can act any more.
  await waitFor(() => expect(screen.getByText(/removed/i)).toBeTruthy());
  expect(screen.getByText('Socket Set').className).toContain('line-through');
  expect(screen.queryByText(/TLY-I-abc123/)).toBeNull();
  expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^queue$/i })).toBeNull();
});

test('(h) Undo is single-shot — a second invoke fires no second DELETE', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: CREATED_ITEM } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);
  await driveTypedCommit();
  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());

  const action = undoActionFor('Socket Set');
  // Sonner dismisses the toast on action click, but the second click can
  // land in the same frame — the guard must be synchronous, not rendered.
  action.onClick();
  action.onClick();

  await waitFor(() => expect(screen.getByText(/removed/i)).toBeTruthy());
  expect(callsTo(fetchMock, '/api/items/_d_/')).toHaveLength(1);
});

test('(i) undoing receipt A while receipt B is still pending touches only A', async () => {
  const gates = [deferred<Response>(), deferred<Response>()];
  let createCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) {
      const gate = gates[createCalls];
      createCalls += 1;
      return gate.promise;
    }
    return jsonResponse({ success: true, data: {} });
  });
  renderCapture(fetchMock);

  await driveTypedCommit('Alpha Box');
  await driveTypedCommit('Beta Box');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(2));

  // A (the older commit) saves; B's create is deliberately held open.
  gates[0].resolve(jsonResponse({ success: true, data: { item: { id: 201, name: 'Alpha Box', qrCode: 'TLY-I-alpha1' } } }));
  await waitFor(() => expect(screen.getByText(/TLY-I-alpha1/)).toBeTruthy());

  undoActionFor('Alpha Box').onClick();

  // A's DELETE fires with A's id; B's pending row is untouched by the patch.
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_d_/201')).toHaveLength(1));
  await waitFor(() => expect(screen.getByText(/removed/i)).toBeTruthy());
  expect(screen.getByText(/saving/i)).toBeTruthy();
  expect(screen.getByText('Beta Box').className).not.toContain('line-through');

  // B still resolves to saved exactly as if no undo had happened next to it.
  gates[1].resolve(jsonResponse({ success: true, data: { item: { id: 202, name: 'Beta Box', qrCode: 'TLY-I-beta22' } } }));
  await waitFor(() => expect(screen.getByText(/TLY-I-beta22/)).toBeTruthy());
  expect(callsTo(fetchMock, '/api/items/_d_/')).toHaveLength(1);
});

test('(f) receipts render newest first, and a state patch never reorders them', async () => {
  const gates = [deferred<Response>(), deferred<Response>()];
  let createCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/items/_y_/create')) {
      const gate = gates[createCalls];
      createCalls += 1;
      return gate.promise;
    }
    return jsonResponse({ success: true, data: {} });
  });
  const { container } = renderCapture(fetchMock);

  await driveTypedCommit('Alpha Box');
  await driveTypedCommit('Beta Box');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(2));

  // Receipt names, top to bottom. On step 1 with the draft reset, the only
  // elements in this style are the receipt rows' name spans.
  const rowNames = () =>
    Array.from(container.querySelectorAll('.text-sm.font-semibold')).map((el) => el.textContent);

  // Newest first: the just-committed row sits at the top of the list.
  expect(rowNames()).toEqual(['Beta Box', 'Alpha Box']);

  // Resolving the OLDER create patches its row in place — no reorder.
  gates[0].resolve(jsonResponse({ success: true, data: { item: { id: 201, name: 'Alpha Box', qrCode: 'TLY-I-alpha1' } } }));
  await waitFor(() => expect(screen.getByText(/TLY-I-alpha1/)).toBeTruthy());
  expect(rowNames()).toEqual(['Beta Box', 'Alpha Box']);

  gates[1].resolve(jsonResponse({ success: true, data: { item: { id: 202, name: 'Beta Box', qrCode: 'TLY-I-beta22' } } }));
  await waitFor(() => expect(screen.getByText(/TLY-I-beta22/)).toBeTruthy());
  expect(rowNames()).toEqual(['Beta Box', 'Alpha Box']);
});
