// @vitest-environment jsdom
/**
 * #280 — the two things /move would not tell a tablet.
 *
 * 1. DISTRIBUTE had no bin list. Its branch rendered exactly TagScanner plus
 *    the typed-code field, while GATHER's rendered the picker as well. So at
 *    the shelf, a peeled, smudged or not-yet-printed label left one way to move
 *    the pin: read a `TLY-C-…` code off something and type it on a glass
 *    keyboard covering half the screen — in the mode you spend the whole
 *    session in. The picker exists, works, and was one component away.
 *
 *    Re-pinning is NOT moving: distribute's contract is that scanning a bin
 *    redirects where the next item goes and moves nothing, so choosing one
 *    from the list has to behave identically. That is the assertion with teeth
 *    here — the pin changes AND no move request is issued.
 *
 * 2. The carried load was not inspectable. `summary` collapses anything past
 *    one entry to "2 bins + 3 items", which is forced on a phone but not at a
 *    desk: the two-column layout exists so the load and the destination can be
 *    read at once, and the left column was rendering a ~90px banner and nothing
 *    else. Gather adds a mis-scanned item silently (the only feedback is the
 *    count in `toast("Carrying N")`), and the only correction was dropping the
 *    whole load — so each row can now be put back on its own.
 *
 * Both are gated so nothing about the fine-pointer desk changes: the picker
 * and its button are coarse-only (the desk's distribute primary is deliberately
 * the typed field), and the list needs the two-column layout to live in.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';
import { useCarryStore } from '@/store/carry-store';
import { PutDown } from './put-down';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/hooks/use-coarse-pointer', () => ({ useCoarsePointer: vi.fn() }));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner" />,
}));
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: ({ onPick, seedAreaId }: { onPick: (b: { id: number; name: string }) => void; seedAreaId?: number }) => (
    <button type="button" data-testid="destination-picker" data-seed={String(seedAreaId ?? '')}
      onClick={() => onPick({ id: 77, name: 'Bin Long' })}>
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

/** Every non-GET that could possibly be a move, recorded. */
const writes: { method: string; url: string }[] = [];

function setSurface(layout: 'sidebar' | 'touch', coarse: boolean) {
  vi.mocked(useLayoutMode).mockReturnValue(layout);
  vi.mocked(useCoarsePointer).mockReturnValue(coarse);
}

function renderMove() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><PutDown /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  writes.length = 0;
  vi.mocked(useLayoutMode).mockReset();
  vi.mocked(useCoarsePointer).mockReset();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') writes.push({ method, url });
    return jsonResponse({ success: true, data: {} });
  }));
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

// ── 1. DISTRIBUTE's bin list ───────────────────────────────────────────────

test('DISTRIBUTE on a touch tablet can re-pin from the list — and re-pinning moves nothing', async () => {
  setSurface('sidebar', true);
  useCarryStore.setState({ pinnedDest: { id: 50, name: 'Bin C', type: 'container' } });
  renderMove();

  fireEvent.click(screen.getByRole('button', { name: /pick a bin from the list/i }));
  fireEvent.click(await screen.findByTestId('destination-picker'));

  await waitFor(() => expect(useCarryStore.getState().pinnedDest?.name).toBe('Bin Long'));
  expect(useCarryStore.getState().pinnedDest).toEqual({ id: 77, name: 'Bin Long', type: 'container' });
  // Re-pin, not land: nothing was carried and nothing may be written.
  expect(writes).toEqual([]);
  // The picker closes and the scanner comes back — the station stays a station.
  await waitFor(() => expect(screen.getByTestId('tag-scanner')).toBeTruthy());
});

test('a pinned AREA seeds the picker with itself; a pinned container opens on the area step', async () => {
  setSurface('sidebar', true);
  useCarryStore.setState({ pinnedDest: { id: 9, name: 'Garage', type: 'area' } });
  renderMove();
  fireEvent.click(screen.getByRole('button', { name: /pick a bin from the list/i }));
  expect((await screen.findByTestId('destination-picker')).getAttribute('data-seed')).toBe('9');
});

test('the fine-pointer desk keeps its typed-field-only DISTRIBUTE (regression pin)', () => {
  setSurface('sidebar', false);
  useCarryStore.setState({ pinnedDest: { id: 50, name: 'Bin C', type: 'container' } });
  renderMove();

  expect(screen.queryByRole('button', { name: /pick a bin from the list/i })).toBeNull();
  expect(screen.queryByTestId('destination-picker')).toBeNull();
  expect(screen.getByPlaceholderText(/type or scan a code/i)).toBeTruthy();
});

// ── 2. The carried-items list ──────────────────────────────────────────────

const LOAD = [
  { id: 1, name: 'Cordless Drill', kind: 'item' as const, fromContainerName: 'Bin A' },
  { id: 2, name: 'Tape Measure', kind: 'item' as const },
  { id: 3, name: 'Spare Tote', kind: 'container' as const },
];

test('a desk lists what is in hand instead of counting it, and each row can be put back', async () => {
  setSurface('sidebar', true);
  useCarryStore.setState({ carried: LOAD });
  renderMove();

  // The summary alone said "1 bin + 2 items"; every entry is now named.
  expect(screen.getByText('Cordless Drill')).toBeTruthy();
  expect(screen.getByText('Tape Measure')).toBeTruthy();
  expect(screen.getByText('Spare Tote')).toBeTruthy();
  expect(screen.getByText(/from Bin A/)).toBeTruthy();

  // A mis-scan is correctable without dropping the whole load.
  fireEvent.click(screen.getByRole('button', { name: /put tape measure back/i }));
  await waitFor(() => expect(useCarryStore.getState().carried.map((c) => c.id)).toEqual([1, 3]));
  expect(screen.queryByText('Tape Measure')).toBeNull();
  // …and it is a client-side correction, not a move.
  expect(writes).toEqual([]);
});

test('one carried thing is already named by the banner, so no list is added', () => {
  setSurface('sidebar', true);
  useCarryStore.setState({ carried: [LOAD[0]] });
  renderMove();

  expect(screen.getByText('Cordless Drill')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /put cordless drill back/i })).toBeNull();
});

test('touch chrome (phone, portrait tablet) is unchanged — no column to put a list in', () => {
  setSurface('touch', true);
  useCarryStore.setState({ carried: LOAD });
  renderMove();

  expect(screen.queryByRole('button', { name: /put tape measure back/i })).toBeNull();
  // The count summary is still what that layout shows.
  expect(screen.getByText('1 bin + 2 items')).toBeTruthy();
});
