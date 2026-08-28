// @vitest-environment jsdom
/**
 * Stacked toast Undos share one lastMove slot (task-3 fix-round-1, item 2).
 *
 * Distribute mode is rapid-fire by design — scan, scan, scan — and sonner
 * stacks toasts for ~4s each. Before this fix, each distribute-mode toast's
 * Undo action read the store's single shared `lastMove` slot AT CLICK TIME.
 * Scan A pins lastMove=A; scan B (before A's toast is dismissed or clicked)
 * overwrites it to lastMove=B; clicking A's still-visible Undo then read the
 * CURRENT slot and reversed B into A's origin — wrong entity, wrong origin.
 *
 * The fix: each toast's action closes over the actual PutDownResult.moved
 * (and unlinkedCount) captured the moment THAT move resolved, and reverses
 * exactly that record directly — never touching `lastMove`. This test drives
 * the real PutDown page through two sequential distribute-mode moves (via
 * the typed-code fallback, so the camera doesn't need mocking beyond a
 * harmless stub), captures the FIRST toast's action, and — only after the
 * SECOND move has already landed and would have clobbered a shared slot —
 * invokes it. The assertion is on the actual network call: item 1 must go
 * back to ITS origin (10), never item 2's (20).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '@/components/ui/toast';
import { useCarryStore } from '@/store/carry-store';
import { PutDown } from './put-down';

vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner">tag scanner</div>,
}));
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: () => <div data-testid="destination-picker" />,
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Item 1 lives in container 10, item 2 in container 20 — both pin to Bin C (50). */
function makeFetchMock() {
  const patchCalls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method?.toUpperCase();

    if (url.includes('/api/labels/_x_/resolve/TLY-I-0001')) {
      return jsonResponse({ success: true, data: { type: 'item', id: 1, name: 'Widget A', exists: true } });
    }
    if (url.includes('/api/labels/_x_/resolve/TLY-I-0002')) {
      return jsonResponse({ success: true, data: { type: 'item', id: 2, name: 'Widget B', exists: true } });
    }
    if (url.includes('/api/items/_x_/1')) {
      return jsonResponse({ success: true, data: { item: { containerId: 10 } } });
    }
    if (url.includes('/api/items/_x_/2')) {
      return jsonResponse({ success: true, data: { item: { containerId: 20 } } });
    }
    if (method === 'PATCH' && url.includes('/move')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchCalls.push({ url, body });
      return jsonResponse({ success: true, data: { item: {}, consequences: null } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  return { fetchMock, patchCalls };
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  useCarryStore.setState({
    carried: [],
    lastMove: null,
    pinnedDest: { id: 50, name: 'Bin C', type: 'container' },
    lastDest: null,
  });

  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

test('a distribute-mode toast Undo reverses ITS OWN move, not whatever landed after it', async () => {
  const { fetchMock, patchCalls } = makeFetchMock();
  vi.stubGlobal('fetch', fetchMock);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PutDown />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const codeInput = screen.getByPlaceholderText(/type the code/i);

  // Scan 1: item A moves to the pin.
  fireEvent.change(codeInput, { target: { value: 'TLY-I-0001' } });
  fireEvent.click(screen.getByRole('button', { name: /go/i }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

  // Capture toast 1's action BEFORE scan 2 happens — this is the exact
  // "still-visible toast from an earlier scan" scenario.
  const firstCallOptions = vi.mocked(toast.success).mock.calls[0][1] as unknown as
    { action: { label: unknown; onClick: () => void } };
  expect(firstCallOptions?.action?.label ?? 'Undo').toBeTruthy();

  // Scan 2: item B moves to the SAME pin — this is what would have
  // overwritten a shared `lastMove` slot before the fix.
  fireEvent.change(codeInput, { target: { value: 'TLY-I-0002' } });
  fireEvent.click(screen.getByRole('button', { name: /go/i }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));

  // Sanity: both moves actually landed on the pin before undo is invoked.
  expect(patchCalls.filter((c) => c.body.containerId === 50)).toHaveLength(2);

  // NOW invoke the FIRST toast's Undo — item B has already landed, so a
  // shared-slot bug would reverse item B (containerId: 20), not item A.
  firstCallOptions.action.onClick();

  await waitFor(() => expect(patchCalls.some((c) => c.body.containerId === 10)).toBe(true));

  // The right entity, the right origin: item 1 went back to container 10.
  const undoCall = patchCalls.find((c) => c.body.containerId === 10);
  expect(undoCall?.url).toContain('/api/items/_p_/1/move');

  // And critically, item 2 was NEVER sent back to ITS origin (20) — the
  // bug this test guards against would have fired exactly that call.
  expect(patchCalls.some((c) => c.body.containerId === 20)).toBe(false);
});
