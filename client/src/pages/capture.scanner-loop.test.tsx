// @vitest-environment jsdom
/**
 * The desk form's USB-scanner loop, driven end to end with real keystrokes.
 *
 * #264 (P0): the loop shipped in #230 worked exactly once. Both halves of that
 * change are correct on their own — the post-commit focus return is for a
 * typist, the barcode field's Enter lookup is for a scanner — but together
 * they sent the operator's caret to Name after every create, so the NEXT pull
 * of the trigger typed the barcode into the name field and its terminating
 * Enter saved it: an item named `098765432109`, no productId, no duplicate
 * check. Neither half is reverted here; focus simply returns to the field the
 * finished item came FROM.
 *
 * userEvent, not fireEvent, for the scanner: a USB reader is a keyboard, so
 * the test has to be one too — character events into whatever holds focus,
 * and a terminating Enter that reaches the form's implicit submit.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const DRILL = { id: 77, name: 'DeWalt 20V MAX Cordless Drill/Driver Kit, Yellow', shortName: 'DeWalt Cordless Drill' };
const SAW = { id: 9, name: 'Makita 7-1/4 in. Circular Saw, 15 Amp', shortName: 'Makita Circular Saw' };

const CATALOGUE: Record<string, typeof DRILL> = {
  '012345678905': DRILL,
  '098765432109': SAW,
};
/** The second code is one the household already owns — the check the loop exists for. */
const OWNED: Record<string, { id: number; name: string; containerName: string; areaName: string }[]> = {
  '098765432109': [{ id: 5, name: 'Makita Circular Saw', containerName: 'Bin A', areaName: 'Garage' }],
};

/** Answers the lookup pair per barcode, and echoes each create back as a saved item. */
function makeCatalogueMock() {
  let nextId = 100;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.includes('/api/products/_y_/lookup')) {
      return jsonResponse({ success: true, data: { product: CATALOGUE[body.barcode] ?? null } });
    }
    if (url.includes('/api/products/_y_/check-duplicate')) {
      return jsonResponse({ success: true, data: { existingItems: OWNED[body.barcode] ?? [] } });
    }
    if (url.includes('/api/items/_y_/create')) {
      nextId += 1;
      return jsonResponse({ success: true, data: { item: { id: nextId, name: body.name, qrCode: `TLY-I-${nextId}` } } });
    }
    return jsonResponse({ success: true, data: {} });
  });
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

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  // A fine-pointer desk: the sidebar query matches, the coarse-pointer query
  // does not — showForm === true, so ManualCreate renders.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === SIDEBAR_QUERY, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
  // A remembered bin, so the loop is exactly what the operator does: scan,
  // glance, Enter. Nothing else is touched between items.
  localStorage.setItem('tally-last-container', JSON.stringify([{ id: 42, name: 'Test Bin', areaId: 7 }]));
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('#264 follow-up: the FIRST scan of a session, with nothing clicked, is still a real product', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);
  const user = userEvent.setup();

  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;
  const barcode = screen.getByPlaceholderText('Type or scan') as HTMLInputElement;

  // Mount focuses Name — correct for a typist, and where a page load, a
  // remount, or a tablet switching into typed mode always starts. Nothing is
  // clicked here: the operator picks up a box and pulls the trigger.
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.keyboard('012345678905{Enter}');

  // The submit refused a name that is nothing but a barcode and ran the
  // lookup instead: no item was written, the code moved into its own field.
  expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(0);
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/products/_y_/check-duplicate')).toHaveLength(1);
  await waitFor(() => expect(barcode.value).toBe('012345678905'));

  // …and the catalogue answer landed in Name, with the caret on it, so the
  // operator's next Enter finishes the item exactly as the loop promises.
  await screen.findByDisplayValue('DeWalt Cordless Drill');
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0])
    .toMatchObject({ name: 'DeWalt Cordless Drill', productId: 77, containerId: 42 });

  // The rescue counts as a barcode-driven item, so the NEXT one starts in
  // the barcode field — the operator never clicks anything all session.
  await waitFor(() => expect(document.activeElement).toBe(barcode));
});

test('#264 follow-up: the guard is on the submit, so a mouse-clicked Create is rescued too', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);

  // A code pasted (or scanned) into Name, then Create clicked with the mouse
  // — no Enter anywhere.
  fireEvent.change(screen.getByPlaceholderText('Cordless drill'), { target: { value: '012345678905' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));

  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(0);
  await screen.findByDisplayValue('DeWalt Cordless Drill');
});

test('#264 follow-up: a name that only looks numeric is left alone once the barcode field is filled', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);

  // The barcode field already holds the code, so digits in Name are the
  // user's own business — a model number, a serial. Nothing is rescued.
  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '012345678905' } });
  fireEvent.keyDown(barcode, { key: 'Enter' });
  await screen.findByDisplayValue('DeWalt Cordless Drill');

  const name = screen.getByPlaceholderText('Cordless drill');
  fireEvent.change(name, { target: { value: '55512345' } });
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));

  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0]).toMatchObject({ name: '55512345', productId: 77 });
});

test('#264 two consecutive scanner creates: the second is the real product, not an item named its own barcode', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);
  const user = userEvent.setup();

  const barcode = screen.getByPlaceholderText('Type or scan') as HTMLInputElement;
  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;

  // The operator clicks into the barcode field ONCE, at the start of the
  // session. Everything after this is trigger pulls and Enter.
  await user.click(barcode);

  // ── ITEM 1 ────────────────────────────────────────────────────────────
  await user.keyboard('012345678905{Enter}');
  await screen.findByDisplayValue('DeWalt Cordless Drill');
  // #230's half: the lookup hands the caret to Name to be glanced at.
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));

  // ── ITEM 2, with the identical gesture ────────────────────────────────
  // Nothing is clicked in between — the caret has to be back where the last
  // item came FROM, or the next trigger pull types digits into Name.
  await waitFor(() => expect(document.activeElement).toBe(barcode));
  expect(barcode.value).toBe('');

  await user.keyboard('098765432109{Enter}');
  await screen.findByDisplayValue('Makita Circular Saw');
  // The whole reason the barcode field exists: the duplicate check ran, and
  // said so, BEFORE this second one was added.
  expect(callsTo(fetchMock, '/api/products/_y_/check-duplicate')).toHaveLength(2);
  await screen.findByText(/you already have one of these/i);

  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(2));

  // Both items are real catalogue products. Before the fix the second body
  // was {name: "098765432109"} with no productId at all.
  const created = bodiesOf(fetchMock, '/api/items/_y_/create');
  expect(created[0]).toMatchObject({ name: 'DeWalt Cordless Drill', productId: 77, containerId: 42 });
  expect(created[1]).toMatchObject({ name: 'Makita Circular Saw', productId: 9, containerId: 42 });
  expect(created.some((b) => /^\d{8,}$/.test(b.name))).toBe(false);
  expect(created.every((b) => b.productId != null)).toBe(true);
});

test('#264 a typed create still returns the caret to Name — the focus rule follows the operator, not a mode', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);
  const user = userEvent.setup();

  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;
  await user.click(name);
  await user.keyboard('Half a bag of screws{Enter}');

  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  // No barcode was touched, so this is #230's typist: next item starts at Name.
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(name.value).toBe('');
});
