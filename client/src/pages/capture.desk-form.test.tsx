// @vitest-environment jsdom
/**
 * The desk form's seven phone-shaped defects (#277).
 *
 * ManualCreate is the camera flow's markup with the camera removed, and every
 * one of these follows from that: a quantity field that coerces per keystroke,
 * a duplicate row that navigates away from the draft, an "Add another" button
 * whose only surviving effect at a desk is discarding what you typed, a draft
 * strip and a dupe banner that shove the form down mid-typing, a receipts list
 * that vanishes when a photo is attached and falls off the fold when it does
 * not, and no recent-bin shortcut on the one surface that files fifty things
 * across several bins.
 *
 * The typed-create loop ITSELF is not touched — one keystroke of overhead per
 * item, focus returned synchronously with the optimistic commit. Everything
 * here is around that loop.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
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

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(path));
}

function bodiesOf(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return callsTo(fetchMock, path).map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

const PRODUCT = { id: 77, name: 'DeWalt 20V MAX Cordless Drill Kit', shortName: 'DeWalt Cordless Drill' };
const OWNED = [{ id: 5, name: 'Cordless Drill', containerName: 'Bin A', areaName: 'Garage' }];

function makeFetchMock({ dupes = false }: { dupes?: boolean } = {}) {
  let nextId = 100;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (url.includes('/api/products/_y_/lookup')) {
      return jsonResponse({ success: true, data: { product: PRODUCT } });
    }
    if (url.includes('/api/products/_y_/check-duplicate')) {
      return jsonResponse({ success: true, data: { existingItems: dupes ? OWNED : [] } });
    }
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({ success: true, data: { available: false, matchAvailable: false, suggestion: null } });
    }
    if (url.includes('/api/items/_y_/create')) {
      nextId += 1;
      return jsonResponse({ success: true, data: { item: { id: nextId, name: body.name, qrCode: `TLY-I-${nextId}` } } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

/** matchMedia for a fine-pointer desk (showForm) or a phone (the camera flow). */
function stubPointer(desk: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: desk && query === SIDEBAR_QUERY, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderCapture(fetchMock: ReturnType<typeof vi.fn>, { desk = true } = {}) {
  stubPointer(desk);
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

/** One remembered bin, so the form is submittable without driving the picker. */
function rememberBins(bins: { id: number; name: string; areaId: number }[]) {
  localStorage.setItem('tally-last-container', JSON.stringify(bins));
}

const JPEG = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });

beforeEach(() => {
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

test('(1) quantity: clear-and-retype files the number that was typed, not one with a resurrected 1 in front', async () => {
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock();
  renderCapture(fetchMock);
  const user = userEvent.setup();

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'Socket Set' } });

  // The gesture most people use: select the 1 away, type the number you want.
  const qty = screen.getByLabelText(/quantity/i) as HTMLInputElement;
  await user.clear(qty);
  expect(qty.value).toBe('');           // the coercion no longer resurrects it
  await user.type(qty, '2');
  expect(qty.value).toBe('2');          // …so the digit is not appended to a 1

  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0]).toMatchObject({ name: 'Socket Set', quantity: 2 });
});

test('(1b) a field left blank coerces on the way out, and files nothing rather than a guess', async () => {
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock();
  renderCapture(fetchMock);
  const user = userEvent.setup();

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'Socket Set' } });
  const qty = screen.getByLabelText(/quantity/i) as HTMLInputElement;
  await user.clear(qty);
  fireEvent.blur(qty);
  // Blur is the coercion point: the box reads back the 1 the item will be saved as…
  expect(qty.value).toBe('1');

  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  // …and nothing is sent, so the column's own default carries it.
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0].quantity).toBeUndefined();
});

test('(2) a duplicate row opens the item in a new tab — the draft and the session list survive', async () => {
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock({ dupes: true });
  renderCapture(fetchMock);
  const open = vi.fn();
  vi.stubGlobal('open', open);

  // One item already committed, so there is a session list to lose.
  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'First Item' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await screen.findByText(/added this session/i);

  // Now a half-typed second item whose barcode turns out to be a duplicate.
  fireEvent.change(name, { target: { value: 'Half-typed thing' } });
  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '885911478694' } });
  fireEvent.keyDown(barcode, { key: 'Enter' });
  await screen.findByText(/you already have one of these/i);

  fireEvent.click(screen.getByRole('button', { name: /Cordless Drill.*Garage.*Bin A/s }));

  expect(open).toHaveBeenCalledWith('/item/5', '_blank', 'noopener');
  // Nothing was unmounted: the draft is still being typed and every receipt's
  // Queue/Print/Retry handle is still on screen.
  expect(name.value).toBe('Half-typed thing');
  expect(screen.getByText(/added this session/i)).toBeTruthy();
});

test('(3) "Add another" is not rendered on the desk form — but is still the camera flow\'s way on', async () => {
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock();
  const { unmount } = renderCapture(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await screen.findByText(/added this session/i);
  // At a desk the phase is already 'photo', so this button's only surviving
  // effect was resetDraft() — a no-confirm discard, styled as the primary.
  expect(screen.queryByRole('button', { name: /add another/i })).toBeNull();

  unmount();
  localStorage.clear();

  // The phone flow, where it earns its place: after a commit you are looking
  // at the receipt list, and this is the way back to a live viewfinder.
  const phoneMock = makeFetchMock();
  renderCapture(phoneMock, { desk: false });
  fireEvent.click(screen.getByRole('button', { name: /skip photo/i }));
  fireEvent.change(await screen.findByPlaceholderText(/name it, or search/i), { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(await screen.findByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'mock-pick-bin' }));
  expect(await screen.findByRole('button', { name: /add another/i })).toBeTruthy();
});

test('(4) typing does not summon the draft strip — its one unique control lives in the form instead', async () => {
  const fetchMock = makeFetchMock();
  renderCapture(fetchMock);

  // The strip used to appear on the FIRST character, pushing the field under
  // the caret down 74px. Its Discard control is the strip's tell.
  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'S' } });
  expect(screen.queryByRole('button', { name: /^discard$/i })).toBeNull();

  // The pills it carried are here, wired to the same draft field.
  const boxOnly = screen.getByRole('button', { name: /box only/i });
  expect(boxOnly.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(boxOnly);
  await waitFor(() => expect(boxOnly.getAttribute('aria-pressed')).toBe('true'));
});

test('(5) attaching a photo does not take the session list away, and (6) the list sits in the form\'s own column', async () => {
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock();
  const { container } = renderCapture(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'First Item' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await screen.findByText(/added this session/i);

  // (6) The log renders inside the right-hand column, under the photo panel
  // that already owns 320px there — not stacked below the form.
  const photoPanel = screen.getByRole('button', { name: /drop one here, or choose a file/i }).parentElement!;
  expect(within(photoPanel).getByText(/added this session/i)).toBeTruthy();

  // (5) acceptPhotoFile moves the flow to 'identify'; the desk form does not
  // read `phase`, and the list must not be gated on it.
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [JPEG] } });
  await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).toBeTruthy());
  expect(screen.getByText(/added this session/i)).toBeTruthy();
  expect(screen.getByText(/TLY-I-101/)).toBeTruthy();

  // The photo can be dropped again without taking the draft with it.
  fireEvent.click(screen.getByRole('button', { name: /remove/i }));
  await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).toBeNull());
  expect(screen.getByText(/added this session/i)).toBeTruthy();
});

test('(6b) the row\'s own Undo still reaches the item from the column the log moved into', async () => {
  // #265 dropped the desk's per-commit success toast because it painted over
  // the Name field, moving its Undo onto the receipt row. #277 then moved the
  // whole list into the form's right column — so this is the merged contract:
  // the only Undo a desk operator has, in its new home, still single-shot.
  rememberBins([{ id: 42, name: 'Test Bin', areaId: 7 }]);
  const fetchMock = makeFetchMock();
  renderCapture(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await screen.findByText(/TLY-I-101/);
  // No toast at a desk — the row IS the record of the commit.
  expect(vi.mocked(toast.success)).not.toHaveBeenCalled();

  const photoPanel = screen.getByRole('button', { name: /drop one here, or choose a file/i }).parentElement!;
  const undo = within(photoPanel).getByRole('button', { name: /undo/i });

  fireEvent.click(undo);
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_d_/101')).toHaveLength(1));
  // Terminal: the row stays as the session's account of the scan, struck
  // through, and nothing on it can act again.
  await screen.findByText(/removed · in the recycle bin/i);
  expect(screen.queryByRole('button', { name: /^undo$/i })).toBeNull();
});

test('(7) the desk form offers the same one-click recent bins the camera flow does', async () => {
  rememberBins([
    { id: 42, name: 'Test Bin', areaId: 7 },
    { id: 43, name: 'Shelf B', areaId: 7 },
  ]);
  const fetchMock = makeFetchMock();
  renderCapture(fetchMock);

  // Both remembered bins are one click away, and the pinned one says so.
  const chip = screen.getByRole('button', { name: 'Shelf B' });
  expect(screen.getByRole('button', { name: 'Test Bin' })).toBeTruthy();

  fireEvent.click(chip);
  // The destination block now names it — no Change → area select → row click.
  await waitFor(() => expect(screen.getAllByText('Shelf B').length).toBeGreaterThan(1));

  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: 'Socket Set' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0].containerId).toBe(43);
});
