// @vitest-environment jsdom
/**
 * Driven regression tests for ManualCreate's scanner-grade barcode path
 * (#230) — the desk form is the USB-barcode-scanner surface, and a USB
 * scanner is a keyboard that types the code and sends Enter.
 *
 * The contract under test:
 *
 *   (a) Enter in the barcode field fires the SAME lookup + dupe check the
 *       camera flow runs — and never the form submit (preventDefault). The
 *       catalogue hit lands in Name. Enter followed by blur is ONE lookup,
 *       not two, for the same unchanged value.
 *   (b) a duplicate code renders the same dupe-warning surface the camera
 *       flow shows (the amber "you already have one of these" block).
 *   (c) after a successful create — the submit is optimistic, so "after"
 *       means the receipt appending synchronously — focus returns to Name.
 *   (d) a photo dropped on the desk form renders the vision review block
 *       (same VisionReview surface as the camera flow) and the suggested
 *       name carries the unconfirmed dashed styling.
 *
 * Mocking follows capture.optimistic.test.tsx: camera-dependent children are
 * stubbed, the page and its network calls are real. The one difference is
 * matchMedia: the sidebar query matches and the coarse-pointer query does
 * not, which is exactly a fine-pointer desk — showForm === true, so the page
 * renders ManualCreate instead of the three-step camera flow.
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

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(path));
}

function renderDesk(fetchMock: ReturnType<typeof vi.fn>) {
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

const PRODUCT = {
  id: 7,
  name: 'DeWalt 20V MAX Cordless Drill/Driver Kit, Yellow',
  shortName: 'DeWalt Cordless Drill',
  barcode: '885911478694',
};

/** A fetch stub for the lookup pair; everything else answers empty-success. */
function makeLookupMock({ product, existingItems }: {
  product: typeof PRODUCT | null;
  existingItems?: { id: number; name: string; containerName: string; areaName: string }[];
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/lookup')) {
      return jsonResponse({ success: true, data: { product } });
    }
    if (url.includes('/api/products/_y_/check-duplicate')) {
      return jsonResponse({ success: true, data: { existingItems: existingItems ?? [] } });
    }
    if (url.includes('/api/items/_y_/create')) {
      return jsonResponse({ success: true, data: { item: { id: 101, name: 'Socket Set', qrCode: 'TLY-I-abc123' } } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  // A fine-pointer desk: the sidebar layout query matches, the coarse-pointer
  // query does not — showForm === true, ManualCreate renders.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === SIDEBAR_QUERY, media: query, onchange: null,
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

test('(a) Enter in the barcode field fires the lookup — not the form — fills Name, and a following blur does not re-fire', async () => {
  const fetchMock = makeLookupMock({ product: PRODUCT });
  renderDesk(fetchMock);

  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '885911478694' } });
  // fireEvent returns false when a handler called preventDefault() — the
  // scanner's Enter terminator must never reach the form's implicit submit.
  const notPrevented = fireEvent.keyDown(barcode, { key: 'Enter' });
  expect(notPrevented).toBe(false);

  // The lookup pair fired — the same two questions the camera flow asks.
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1));
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/check-duplicate')).toHaveLength(1));
  expect(JSON.parse(callsTo(fetchMock, '/api/products/_y_/lookup')[0][1].body as string))
    .toEqual({ barcode: '885911478694' });
  // …and no item was created.
  expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(0);

  // The catalogue hit lands in Name (short name preferred), and focus moves
  // there so scan → glance → Enter is the whole loop.
  const name = await screen.findByDisplayValue('DeWalt Cordless Drill');
  expect((name as HTMLInputElement).id).toBe('mc-name');
  await waitFor(() => expect(document.activeElement).toBe(name));

  // The USB-scanner reality: Enter then blur, same unchanged value — one
  // lookup, not two.
  fireEvent.blur(barcode);
  await new Promise((r) => setTimeout(r, 25));
  expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1);
  expect(callsTo(fetchMock, '/api/products/_y_/check-duplicate')).toHaveLength(1);
});

test('(b) a duplicate code renders the same dupe-warning surface the camera flow shows', async () => {
  const fetchMock = makeLookupMock({
    product: PRODUCT,
    existingItems: [{ id: 5, name: 'DeWalt Cordless Drill', containerName: 'Tool Chest', areaName: 'Garage' }],
  });
  renderDesk(fetchMock);

  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '885911478694' } });
  fireEvent.keyDown(barcode, { key: 'Enter' });

  // The camera flow's amber block, byte-identical: headline, the owned
  // item's row with its location, and the not-a-block reassurance.
  await screen.findByText(/you already have one of these/i);
  expect(screen.getByRole('button', { name: /DeWalt Cordless Drill.*Garage.*Tool Chest/s })).toBeTruthy();
  expect(screen.getByText(/adding another is fine — this is a heads-up, not a block/i)).toBeTruthy();

  // Dismissable exactly like the camera flow's.
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByText(/you already have one of these/i)).toBeNull();
});

test('(c) after a successful create, focus returns to Name', async () => {
  // A remembered bin so the form is submittable without driving the picker.
  localStorage.setItem('tally-last-container', JSON.stringify([{ id: 42, name: 'Test Bin', areaId: 7 }]));
  const fetchMock = makeLookupMock({ product: null });
  renderDesk(fetchMock);

  const name = screen.getByPlaceholderText('Cordless drill');
  fireEvent.change(name, { target: { value: 'Socket Set' } });

  // Park focus elsewhere so the assertion below can only pass if the form
  // actively returns it — jsdom moves no focus on button clicks.
  const desc = screen.getByPlaceholderText('Anything you would want to search for later');
  desc.focus();
  expect(document.activeElement).toBe(desc);

  fireEvent.click(screen.getByRole('button', { name: /create item/i }));

  // The commit is optimistic: the receipt appends synchronously and the form
  // clears — that append is the transition the focus return rides on.
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect((name as HTMLInputElement).value).toBe('');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  await waitFor(() => expect(screen.getByText(/TLY-I-abc123/)).toBeTruthy());
});

test('(d) a photo dropped on the desk form renders the vision review block with unconfirmed-name styling', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({
        success: true,
        data: {
          available: true, matchAvailable: false,
          suggestion: {
            name: 'Cast Iron Skillet', description: 'A 12-inch pre-seasoned cast iron skillet',
            category: 'kitchen', brand: null, quantity: null, estimatedValue: 40, confidence: 'high',
          },
        },
      });
    }
    return jsonResponse({ success: true, data: {} });
  });
  renderDesk(fetchMock);

  // Drop a photo on the form's photo panel — the shared acceptPhotoFile path.
  const dropTarget = screen.getByRole('button', { name: /drop one here, or choose a file/i });
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'skillet.jpg', { type: 'image/jpeg' });
  fireEvent.drop(dropTarget, { dataTransfer: { files: [photo] } });

  // The suggestion pre-fills Name, marked unconfirmed: the camera flow's
  // dashed border, on the desk form's own field.
  const name = await screen.findByDisplayValue('Cast Iron Skillet');
  expect((name as HTMLInputElement).id).toBe('mc-name');
  expect(name.className).toContain('border-dashed');

  // The draft strip offers the review — and on the desk form the SAME
  // VisionReview block the camera flow renders now actually opens.
  fireEvent.click(await screen.findByRole('button', { name: /review what it found/i }));
  expect(screen.getByText(/from the photo — read/i)).toBeTruthy();
  expect(screen.getByText('A 12-inch pre-seasoned cast iron skillet')).toBeTruthy();
  expect(screen.getByText(/appears in insurance reports/i)).toBeTruthy();

  // Keep on the description proves the block is wired to the live draft:
  // the accepted text lands in the form's own description field.
  fireEvent.click(screen.getAllByRole('button', { name: /^keep$/i })[0]);
  await waitFor(() =>
    expect(screen.getByDisplayValue('A 12-inch pre-seasoned cast iron skillet')).toBeTruthy());

  // Editing the name makes it theirs — the unconfirmed styling drops.
  fireEvent.change(name, { target: { value: 'Lodge Cast Iron Skillet' } });
  expect(name.className).not.toContain('border-dashed');
});
