// @vitest-environment jsdom
/**
 * Recycle bin: selectable rows + bulk Restore + ancestor-blocked rendering (#229).
 *
 * Select mode is deliberately minimal here (a toggle, checkboxes, one bulk
 * action) — no delete/tag, unlike container-detail's fuller select mode
 * (#231), which this borrows the toggle/checkbox/action-bar shape from.
 *
 * The ancestor-blocked-restore renderer is exercised against three payload
 * shapes on purpose: recycle.routes.js's `error(res, err.message,
 * err.statusCode)` call passes no fourth argument today, so production only
 * ever sends the "neither id nor name" shape — but the renderer is written
 * to also handle a payload that does carry the ancestor (as a link, or as a
 * bare name) without a server change, and all three are pinned here via a
 * mocked fetch response so a future payload change is covered already.
 *
 * No @testing-library/jest-dom in this repo (see container-detail.bulk.test.tsx),
 * so assertions read raw DOM properties/attributes.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toast } from '@/components/ui/toast';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { RecycleBinList } from './recycle-bin-list';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

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

const batches: Batch[] = [
  makeBatch({ id: 1, rootName: 'Drill' }),
  makeBatch({ id: 2, rootName: 'Sander' }),
  makeBatch({ id: 3, rootName: 'Level' }),
];

/** restorePlan maps batchId -> a Response factory, so each test can rig
 * exactly which restores succeed/fail/carry what payload. Ids with no entry
 * succeed with a plain 200. */
function makeFetchMock(restorePlan: Record<number, () => Response>) {
  const restoreCalls: number[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/recycle/_x_/list')) {
      return jsonResponse({ success: true, data: { batches } });
    }
    const restoreMatch = url.match(/\/api\/recycle\/_y_\/restore\/(\d+)/);
    if (restoreMatch && init?.method === 'POST') {
      const id = Number(restoreMatch[1]);
      restoreCalls.push(id);
      const plan = restorePlan[id];
      return plan ? plan() : jsonResponse({ success: true, data: { restored: {} } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  return { fetchMock, restoreCalls };
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

/** The outer row <div> for a given root name — the paragraph's grandparent,
 * since {name} sits in a "flex-1 min-w-0" wrapper that is itself a child of
 * the row (a sibling of the per-row Restore button / checkbox). */
async function findRow(name: string): Promise<HTMLElement> {
  const p = await screen.findByText(name);
  return p.closest('div')!.parentElement as HTMLElement;
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('Select turns on checkboxes; a row toggles selection and the bar tracks the count', async () => {
  vi.stubGlobal('fetch', makeFetchMock({}).fetchMock);
  renderList();

  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  const row = screen.getByRole('button', { name: 'Select Drill' });
  expect(row.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(row);
  expect(row.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getByText('3 selected')).toBeTruthy();
});

test('bulk Restore loops sequentially, continues past a failure, and reports a truthful outcome', async () => {
  const { fetchMock, restoreCalls } = makeFetchMock({
    2: () => jsonResponse({ success: false, message: 'boom' }, 500),
  });
  vi.stubGlobal('fetch', fetchMock);
  renderList();

  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  fireEvent.click(screen.getByRole('button', { name: /^Restore 3$/ }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith('Restored 2 · 1 failed'));

  // Continue-on-failure: id 3 still gets attempted after id 2 rejects.
  expect(restoreCalls).toEqual([1, 2, 3]);

  // The failed row stays selected; the bar now reads 1.
  expect(screen.getByText('1 selected')).toBeTruthy();
});

test('a blocked restore whose payload carries an ancestor id renders it as a LINK', async () => {
  vi.stubGlobal('fetch', makeFetchMock({
    2: () => jsonResponse({
      success: false,
      message: 'Restore the area this was in first',
      errors: { ancestorType: 'area', ancestorId: 77, ancestorName: 'Garage' },
    }, 409),
  }).fetchMock);
  renderList();

  const row = await findRow('Sander');
  fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));

  await waitFor(() => {
    const link = within(row).getByRole('link', { name: 'Garage' });
    expect(link.getAttribute('href')).toBe('/area/77');
  });
});

test('a blocked restore whose payload carries only a name (no id) renders plain text, not a link', async () => {
  vi.stubGlobal('fetch', makeFetchMock({
    2: () => jsonResponse({
      success: false,
      message: 'Restore the area this was in first',
      errors: { ancestorType: 'area', ancestorName: 'Garage' },
    }, 409),
  }).fetchMock);
  renderList();

  const row = await findRow('Sander');
  fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));

  await within(row).findByText('Restore Garage first');
  expect(within(row).queryByRole('link', { name: /Garage/i })).toBeNull();
});

test('a blocked restore whose payload carries neither (today\'s real server shape) renders the plain message', async () => {
  vi.stubGlobal('fetch', makeFetchMock({
    2: () => jsonResponse({ success: false, message: 'Restore the area this was in first' }, 409),
  }).fetchMock);
  renderList();

  const row = await findRow('Sander');
  fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));

  await within(row).findByText('Restore the area this was in first');
});

test('Restore/Select are disabled with a progress label while the bulk loop runs', async () => {
  let resolveSecond: (() => void) | null = null;
  const { fetchMock } = makeFetchMock({});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/recycle/_y_/restore/2')) {
      return new Promise<Response>((res) => { resolveSecond = () => res(jsonResponse({ success: true, data: {} })); });
    }
    return fetchMock(input, init);
  }));
  renderList();

  await screen.findByText('Drill');
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  fireEvent.click(screen.getByRole('button', { name: /^Restore 3$/ }));

  await screen.findByText('Restoring… 2 of 3');
  const bulkBtn = screen.getByText('Restoring… 2 of 3').closest('button') as HTMLButtonElement;
  expect(bulkBtn.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'All' }) as HTMLButtonElement).disabled).toBe(true);

  resolveSecond!();
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Restored 3'));
});
