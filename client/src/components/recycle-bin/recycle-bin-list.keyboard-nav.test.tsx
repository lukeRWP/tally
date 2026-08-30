// @vitest-environment jsdom
/**
 * #272: the recycle bin's twin (container-detail.tsx) had shift-click ranges
 * and a keyboard ring; this page had neither. This file pins the two things
 * that closed that gap:
 *
 *  - a `(id)` keyed ring (the twin's `(type, id)` collapses to a plain id
 *    here — every row is the same "kind", a delete batch) driven by
 *    useKeyboardNav/useNavCursorParam/useNavScrollIntoView, same contract as
 *    container-detail.keyboard-nav.test.tsx pins there;
 *  - shift-click ranges in toggleSelected, ported from container-detail's
 *    ~12-line branch.
 *
 * Everything else about this page (minimal select mode, inline per-row
 * restore failures, the #267 blur fix, the shared bottom-stack bar) is
 * covered by recycle-bin-list.test.tsx and untouched here.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toast } from '@/components/ui/toast';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { RecycleBinList } from './recycle-bin-list';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});
// Not exercised in this file (no test opens Purge Expired), but keeping this
// file's shape close to container-detail.keyboard-nav.test.tsx's own dialog
// mocks means a future "dialog gates the ring" test costs nothing to add.
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Batch {
  id: number; rootType: 'area' | 'container' | 'item'; rootId: number; rootName: string;
  propertyName: string | null; deletedAt: string; deletedByName: string | null;
  daysLeft: number | null; areaCount: number; containerCount: number; itemCount: number;
}

function makeBatch(over: Partial<Batch> & { id: number; rootName: string }): Batch {
  return {
    rootType: 'item', rootId: over.id, propertyName: 'Home', deletedAt: '2026-08-01T00:00:00Z',
    deletedByName: 'Luke', daysLeft: 20, areaCount: 0, containerCount: 0, itemCount: 0,
    ...over,
  };
}

const seedBatches: Batch[] = [
  makeBatch({ id: 1, rootName: 'Drill' }),
  makeBatch({ id: 2, rootName: 'Sander' }),
  makeBatch({ id: 3, rootName: 'Level' }),
  makeBatch({ id: 4, rootName: 'Router' }),
];

// Mutable so the reconcile test can simulate a real restore actually
// shrinking what the list endpoint returns next time it's fetched — this
// page has no mocked `useX` hooks to swap out, only `fetch`, so the
// reconcile has to come from the real invalidate -> refetch loop rather
// than a `rerender` with new mock data (container-detail's own approach).
let currentBatches: Batch[] = seedBatches;

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/recycle/_x_/list')) {
      return jsonResponse({ success: true, data: { batches: currentBatches } });
    }
    const restoreMatch = url.match(/\/api\/recycle\/_y_\/restore\/(\d+)/);
    if (restoreMatch && init?.method === 'POST') {
      const id = Number(restoreMatch[1]);
      currentBatches = currentBatches.filter((b) => b.id !== id);
      return jsonResponse({ success: true, data: { restored: {} } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RecycleBinList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The row wrapper itself carries data-nav-id AND the ring classes (unlike
 * container-detail, where those live on a separate div wrapping a card). */
function ringOn(name: string): boolean {
  const row = screen.getByText(name).closest('[data-nav-id]');
  return !!row && row.className.includes('ring-1');
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  currentBatches = [...seedBatches];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The ring ───────────────────────────────────────────────────────────────

test('j walks the deletions in rendered order, outside select mode too', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(true);

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Sander')).toBe(true);
  expect(ringOn('Drill')).toBe(false);

  fireEvent.keyDown(window, { key: 'k' });
  expect(ringOn('Drill')).toBe(true);
});

test('Escape clears the ring', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(true);

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(ringOn('Drill')).toBe(false);
});

test('the ring is off entirely on touch chrome', async () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(false);
});

test('outside select mode, Enter on a highlighted row is inert — a batch has no detail page to open', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.keyDown(window, { key: 'j' });
  expect(ringOn('Drill')).toBe(true);

  fireEvent.keyDown(window, { key: 'Enter' });
  // Still just the ring, nothing selected, nothing restored.
  expect(ringOn('Drill')).toBe(true);
  expect(screen.queryByText(/selected/)).toBeNull();
});

test('in select mode, Enter ticks the highlighted row — same as the twin', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.keyDown(window, { key: 'j' }); // Drill
  fireEvent.keyDown(window, { key: 'j' }); // Sander
  fireEvent.keyDown(window, { key: 'Enter' });

  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Select Sander' }).getAttribute('aria-pressed')).toBe('true');
});

test('the ring reconciles (clears) once the highlighted row is actually restored', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');

  fireEvent.keyDown(window, { key: 'j' }); // Drill
  fireEvent.keyDown(window, { key: 'j' }); // Sander
  expect(ringOn('Sander')).toBe(true);

  // The per-row Restore button — outside select mode, this is the only
  // action a row has, and it's the one the ring's own Enter deliberately
  // stays out of (previous test) rather than duplicating.
  const sanderRestore = screen.getByText('Sander').closest('div')!.parentElement!
    .querySelector('button') as HTMLButtonElement;
  fireEvent.click(sanderRestore);

  await waitFor(() => expect(screen.queryByText('Sander')).toBeNull());
  // An index-based cursor would now silently point at whatever row slid into
  // Sander's old slot (Level); id-based tracking must clear it instead.
  expect(ringOn('Level')).toBe(false);
  expect(ringOn('Drill')).toBe(false);
});

// ── Shift-click ranges ───────────────────────────────────────────────────

test('#272: shift-click selects the range from the anchor, in rendered order — not just the two endpoints', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  fireEvent.click(screen.getByRole('button', { name: 'Select Drill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Router' }), { shiftKey: true });

  // All four rows, not "2 selected" the way the issue's bug reported.
  expect(screen.getByText('4 selected')).toBeTruthy();
  for (const name of ['Drill', 'Sander', 'Level', 'Router']) {
    expect(screen.getByRole('button', { name: `Select ${name}` }).getAttribute('aria-pressed')).toBe('true');
  }
});

test('a shift-click range is additive: it never drops a row picked before the anchor', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  // Router first (its own anchor, outside the eventual range) — the range
  // gesture must ADD to this, not replace the whole selection with itself.
  fireEvent.click(screen.getByRole('button', { name: 'Select Router' }));
  // New anchor at Drill, then shift-click to Sander: range is Drill..Sander.
  fireEvent.click(screen.getByRole('button', { name: 'Select Drill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Sander' }), { shiftKey: true });

  expect(screen.getByText('3 selected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Select Router' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Select Level' }).getAttribute('aria-pressed')).toBe('false');
});

test('a shift-click with no prior anchor (nothing selected yet) just toggles the one row', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  fireEvent.click(screen.getByRole('button', { name: 'Select Sander' }), { shiftKey: true });

  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Select Sander' }).getAttribute('aria-pressed')).toBe('true');
});

test('shift-clicking the anchor itself falls through to a plain toggle, same as the twin', async () => {
  vi.stubGlobal('fetch', makeFetchMock());
  renderList();
  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  fireEvent.click(screen.getByRole('button', { name: 'Select Drill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Drill' }), { shiftKey: true });

  // container-detail's own range branch only fires when
  // `anchor.current !== key` — shift-clicking the anchor itself falls
  // through to the plain toggle instead, which (Drill already being
  // selected) turns it back off. Pinning the twin's actual behaviour here,
  // not a guessed "shift always adds" rule.
  expect(screen.getByText('0 selected')).toBeTruthy();
});
