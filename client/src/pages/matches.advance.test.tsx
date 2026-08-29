// @vitest-environment jsdom
/**
 * /matches auto-advance + bulk-clear failed rows (#228, task-3 brief).
 *
 * Before this: resolving or dismissing a match always fell back to
 * `select(null)`, dumping the user on the empty placeholder even when more
 * `ready` rows were waiting — ~30 avoidable navigations per sitting on a
 * typical backlog. `nextPendingAfter` (pure, exported from matches.tsx) picks
 * the next actionable row instead; this file covers it directly plus the
 * wiring that calls it.
 *
 * Status-literal note: the brief's shorthand "pending" is this codebase's
 * `ready` — resolve/dismiss can only ever fire against a `ready` row (that's
 * the only status whose panel renders "Use this" / "None of these"; queued/
 * searching have no action yet, none/failed only link out to rescan/search).
 * `none`/`failed` map straight across for the bulk-clear feature.
 *
 * The freshness test below is the one the brief specifically calls out:
 * nextPendingAfter must be evaluated against `rows` as they stand at mutation
 * SUCCESS time, not the array closed over when the click handler ran — a
 * background poll (the list refetches every 5s while anything is
 * queued/searching) can land in between. matches.tsx satisfies this with a
 * `rowsRef` kept current via a `useEffect`, read inside the onSuccess
 * callback instead of the render-scoped `rows`.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { ProductMatch } from '@/hooks/use-matches';
import { MatchesPage, nextPendingAfter } from './matches';

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));

let currentRows: ProductMatch[] = [];
const mutateMock = vi.fn();
const mutateAsyncMock = vi.fn();

vi.mock('@/hooks/use-matches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-matches')>();
  return {
    ...actual,
    useMatches: () => ({ data: currentRows, isLoading: false }),
    useResolveMatch: () => ({ mutate: mutateMock, mutateAsync: mutateAsyncMock, isPending: false }),
  };
});

function makeRow(id: number, status: ProductMatch['status'], overrides: Partial<ProductMatch> = {}): ProductMatch {
  return {
    id,
    itemId: id * 100,
    itemName: `Item ${id}`,
    containerName: 'Bin',
    status,
    candidates: status === 'ready'
      ? [{
        name: 'Widget', brand: null, model: null, upc: null, priceUsd: null,
        imageUrl: null, sourceUrl: 'https://example.com/w', sourceDomain: 'example.com',
      }]
      : [],
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="url">{location.pathname + location.search}</div>;
}

function matchesTree() {
  return (
    <Routes>
      <Route path="/matches" element={<><Probe /><MatchesPage /></>} />
    </Routes>
  );
}

function renderMatches(initialEntries: string[] = ['/matches']) {
  return render(<MemoryRouter initialEntries={initialEntries}>{matchesTree()}</MemoryRouter>);
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  currentRows = [];
  mutateMock.mockReset();
  mutateAsyncMock.mockReset();
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── nextPendingAfter (pure) ──────────────────────────────────────────────

test('(a) resolving a middle row selects the next ready row below it', () => {
  const rows = [makeRow(1, 'ready'), makeRow(2, 'ready'), makeRow(3, 'ready')];
  expect(nextPendingAfter(rows, 2)).toBe(3);
});

test('(b) resolving the last ready row wraps to the first ready row above', () => {
  const rows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  expect(nextPendingAfter(rows, 2)).toBe(1);
});

test('(c) resolving the only ready row returns null (caller falls back to select(null))', () => {
  const rows = [makeRow(1, 'ready'), makeRow(2, 'none'), makeRow(3, 'failed')];
  expect(nextPendingAfter(rows, 1)).toBeNull();
});

test('nextPendingAfter skips queued/searching/none/failed rows and the resolved id itself', () => {
  const rows = [makeRow(1, 'ready'), makeRow(2, 'queued'), makeRow(3, 'failed'), makeRow(4, 'ready')];
  expect(nextPendingAfter(rows, 1)).toBe(4);
});

// ── Integration: resolve/dismiss auto-advance wiring ────────────────────

test('resolving a match selects the next ready row via the URL', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'Use this' }));

  expect(mutateMock).toHaveBeenCalledTimes(1);
  const [vars, opts] = mutateMock.mock.calls[0];
  expect(vars).toEqual({ id: 1, candidateIndex: 0 });

  await act(async () => { opts.onSuccess({ product: { id: 9, name: 'Widget', brand: null, barcode: null }, duplicates: [] }); });

  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=2');
});

test('(d) dismiss auto-advances the same way resolve does', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'None of these' }));

  const [vars, opts] = mutateMock.mock.calls[0];
  expect(vars).toEqual({ id: 1, dismiss: true });

  await act(async () => { opts.onSuccess(undefined); });

  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=2');
  expect(toast).toHaveBeenCalledWith('Dismissed');
});

test('(e) a 409 on resolve keeps select(null) instead of auto-advancing', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
  const [, opts] = mutateMock.mock.calls[0];

  await act(async () => { opts.onError(new ApiError('Conflict', 409)); });

  expect(screen.getByTestId('url').textContent).toBe('/matches');
});

test('a 409 on dismiss also keeps select(null)', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'None of these' }));
  const [, opts] = mutateMock.mock.calls[0];

  await act(async () => { opts.onError(new ApiError('Conflict', 409)); });

  expect(screen.getByTestId('url').textContent).toBe('/matches');
});

test('auto-advance reads rows fresh at success time, not the click-time closure', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'ready')];
  const { rerender } = renderMatches(['/matches?sel=1']);

  fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
  const [, opts] = mutateMock.mock.calls[0];

  // Simulate the background poll landing before the mutation settles: row 2
  // (what a stale click-time closure would still call "ready") has since
  // been dismissed by someone else, and a new row 3 has come ready. Re-render
  // the SAME MatchesPage instance (MemoryRouter's history is created once, so
  // this does not reset the URL) with the updated mocked data.
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'none'), makeRow(3, 'ready')];
  rerender(<MemoryRouter initialEntries={['/matches?sel=1']}>{matchesTree()}</MemoryRouter>);

  await act(async () => { opts.onSuccess({ product: null, duplicates: [] }); });

  // Fresh answer is row 3. The stale (click-time) answer would have been 2.
  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=3');
});

// ── Bulk-clear failed rows ───────────────────────────────────────────────

test('the bulk-clear button only appears when there are none/failed rows, with the right count', () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'queued')];
  renderMatches();
  expect(screen.queryByRole('button', { name: /Clear \d+ failed/ })).toBeNull();

  currentRows = [makeRow(1, 'ready'), makeRow(2, 'none'), makeRow(3, 'failed')];
  renderMatches();
  expect(screen.getByRole('button', { name: 'Clear 2 failed' })).toBeTruthy();
});

test('(f) bulk-clear fires sequential dismiss calls, tracks progress, and toasts one outcome', async () => {
  currentRows = [makeRow(1, 'ready'), makeRow(2, 'none'), makeRow(3, 'failed'), makeRow(4, 'failed')];
  const deferred: ReturnType<typeof makeDeferred<unknown>>[] = [];
  mutateAsyncMock.mockImplementation(() => {
    const d = makeDeferred<unknown>();
    deferred.push(d);
    return d.promise;
  });

  renderMatches();

  fireEvent.click(screen.getByRole('button', { name: 'Clear 3 failed' }));

  await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
  expect(mutateAsyncMock).toHaveBeenNthCalledWith(1, { id: 2, dismiss: true });
  const progressBtn = screen.getByRole('button', { name: 'Clearing… 0 of 3' }) as HTMLButtonElement;
  expect(progressBtn.disabled).toBe(true);

  await act(async () => { deferred[0].resolve(undefined); });
  await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(2));
  expect(mutateAsyncMock).toHaveBeenNthCalledWith(2, { id: 3, dismiss: true });
  expect(screen.getByRole('button', { name: 'Clearing… 1 of 3' })).toBeTruthy();

  await act(async () => { deferred[1].resolve(undefined); });
  await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(3));
  expect(mutateAsyncMock).toHaveBeenNthCalledWith(3, { id: 4, dismiss: true });
  expect(screen.getByRole('button', { name: 'Clearing… 2 of 3' })).toBeTruthy();

  await act(async () => { deferred[2].resolve(undefined); });

  await waitFor(() => expect(toast).toHaveBeenCalledWith('Cleared 3'));
  expect((screen.getByRole('button', { name: 'Clear 3 failed' }) as HTMLButtonElement).disabled).toBe(false);
});

test('(f) a mid-loop bulk-clear failure stops and toasts a truthful partial count', async () => {
  currentRows = [makeRow(1, 'none'), makeRow(2, 'failed'), makeRow(3, 'failed')];
  mutateAsyncMock
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('network blip'));

  renderMatches();

  fireEvent.click(screen.getByRole('button', { name: 'Clear 3 failed' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith('Cleared 1 of 3'));
  // Stopped after the failure — the third row was never attempted.
  expect(mutateAsyncMock).toHaveBeenCalledTimes(2);
  expect((screen.getByRole('button', { name: 'Clear 3 failed' }) as HTMLButtonElement).disabled).toBe(false);
});
