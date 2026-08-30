// @vitest-environment jsdom
/**
 * Who owns the name on the desk form (#266).
 *
 * A barcode lookup used to give the catalogue title precedence over whatever
 * was in the field — unmarked, and on merely tabbing out of the barcode field
 * as well as on Enter. At a desk both fields are on screen together, so "name
 * it, then scan it" is the natural order for anything whose catalogue title is
 * wrong for the household ("Dad's old drill", "the good extension lead"), and
 * that order was the one being punished.
 *
 * A name someone typed is a decision about THIS object; the catalogue title is
 * a fact about the product. Both survive: the typed name stays in the field,
 * the title is offered behind the Keep affordance VisionReview established,
 * and the productId lands on the item either way. An untouched (or merely
 * model-suggested) name is still replaced outright — there is nothing there to
 * protect, and a catalogue hit beats a guess.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

test('#266 a barcode lookup keeps a hand-typed name and offers the catalogue title behind Keep', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);

  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Dad's old drill" } });

  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '012345678905' } });
  fireEvent.keyDown(barcode, { key: 'Enter' });

  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1));
  // The name they typed is still theirs, and is not wearing the unconfirmed
  // border either — nothing replaced it.
  expect(name.value).toBe("Dad's old drill");
  expect(name.className).not.toContain('border-dashed');

  // The catalogue title is offered rather than applied.
  expect(await screen.findByText('DeWalt Cordless Drill')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^keep$/i }));
  await waitFor(() => expect(name.value).toBe('DeWalt Cordless Drill'));
  // Taken once, the offer is gone.
  expect(screen.queryByRole('button', { name: /^keep$/i })).toBeNull();
});

test('#266 tabbing out of the barcode field does not overwrite the typed name, and the product link still lands', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);

  const name = screen.getByPlaceholderText('Cordless drill') as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'The good extension lead' } });

  // No Enter at all — merely leaving the field used to be enough.
  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '012345678905' } });
  fireEvent.blur(barcode);

  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/lookup')).toHaveLength(1));
  expect(name.value).toBe('The good extension lead');

  // The product is still a fact about this object: the create carries the
  // user's name AND the catalogue's productId.
  fireEvent.click(screen.getByRole('button', { name: /create item/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/items/_y_/create')).toHaveLength(1));
  expect(bodiesOf(fetchMock, '/api/items/_y_/create')[0])
    .toMatchObject({ name: 'The good extension lead', productId: 77 });
});

test('#266 an untouched name still takes the catalogue title outright — nothing to protect, nothing to offer', async () => {
  const fetchMock = makeCatalogueMock();
  renderDesk(fetchMock);

  const barcode = screen.getByPlaceholderText('Type or scan');
  fireEvent.change(barcode, { target: { value: '012345678905' } });
  fireEvent.keyDown(barcode, { key: 'Enter' });

  const name = await screen.findByDisplayValue('DeWalt Cordless Drill');
  expect((name as HTMLInputElement).id).toBe('mc-name');
  expect(screen.queryByRole('button', { name: /^keep$/i })).toBeNull();
});
