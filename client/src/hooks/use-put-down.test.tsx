// @vitest-environment jsdom
/**
 * The multi-confirm unmount hang (task-3 obligation 2).
 *
 * put-down.tsx's unmount cleanup resolves whatever confirm is CURRENTLY
 * pending as a cancel — but usePutDown's PASS 2 loop is sequential: the
 * moment that decision resolves, the loop moves to the NEXT entity still
 * waiting on a 409 and calls confirmPrompt again. If the component is gone,
 * that second call sets state nobody will ever read and returns a Promise
 * nobody will ever resolve — putDown hangs forever, completeMove never
 * runs, and every entity that already moved in PASS 1 stays stuck showing
 * as carried.
 *
 * The fix is that the unmount decision carries `applyToRest: true`
 * (not false) — the loop's own "apply this choice to everything still
 * waiting" path skips the rest of the queue and stops, instead of asking it
 * again. This test drives usePutDown for real (no mocking the hook itself)
 * through a Harness that reproduces put-down.tsx's exact confirm-wiring
 * contract — confirmPrompt/decide/the unmount effect — with a 2-entity
 * confirm queue, unmounts mid-way through the FIRST prompt, and asserts
 * putDown still resolves, with the correct moved/skipped split, rather than
 * hanging.
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePutDown, type ConfirmPrompt, type PutDownResult } from './use-put-down';
import type { CarriedItem } from '@/store/carry-store';
import type { PutDownTarget } from './use-put-down';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Both entities 409 on their first (unconfirmed) attempt, every time. */
function makeAlways409FetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/move')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.confirm) {
        return jsonResponse({ success: true, data: { item: { id: 1 }, container: { id: 1 }, consequences: null } });
      }
      return jsonResponse(
        { success: false, message: 'Crosses properties', errors: { unlinked: [], tagsCarried: 1, tagsCreated: 0 } },
        409,
      );
    }
    return jsonResponse({ success: true, data: {} });
  });
}

/**
 * Reproduces put-down.tsx's confirm-wiring contract in isolation: a
 * confirmPrompt that pauses on a Promise (never auto-resolving, since a
 * real confirm sheet waits on a human), a decisionRef resume handle, and the
 * unmount cleanup that must resolve any still-pending decision so putDown
 * can never hang past this component's lifetime.
 *
 * `unmountApplyToRest` is the one thing under test — the harness can drive
 * both the buggy (false) and fixed (true) behaviour so the test actually
 * proves the fix does something, not just that putDown resolves somehow.
 */
function Harness({
  load, dest, onSettled, unmountApplyToRest, onPrompt,
}: {
  load: CarriedItem[];
  dest: PutDownTarget;
  onSettled: (result: PutDownResult | null) => void;
  unmountApplyToRest: boolean;
  onPrompt: () => void;
}) {
  const { putDown } = usePutDown();
  const decisionRef = React.useRef<((d: { choice: 'confirm' | 'cancel'; applyToRest: boolean }) => void) | null>(null);

  const confirmPrompt: ConfirmPrompt = React.useCallback((_entity, _index, _total, _consequences) => {
    onPrompt();
    return new Promise((resolve) => { decisionRef.current = resolve; });
  }, [onPrompt]);

  React.useEffect(() => {
    void putDown(load, dest, confirmPrompt).then(onSettled);
    return () => {
      decisionRef.current?.({ choice: 'cancel', applyToRest: unmountApplyToRest });
      decisionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function renderHarness(props: Omit<React.ComponentProps<typeof Harness>, 'onPrompt'> & { onPrompt?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness onPrompt={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usePutDown — unmount mid multi-confirm queue', () => {
  it('FIXED (applyToRest: true): unmounting during the first of two pending confirms still resolves putDown, skipping both', async () => {
    const fetchMock = makeAlways409FetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const load: CarriedItem[] = [
      { id: 1, name: 'Widget A', kind: 'item', fromContainerId: 10 },
      { id: 2, name: 'Widget B', kind: 'item', fromContainerId: 10 },
    ];
    const dest: PutDownTarget = { type: 'container', id: 99, name: 'Bin C' };

    const onSettled = vi.fn();
    let promptCount = 0;
    const { unmount } = renderHarness({
      load, dest, onSettled, unmountApplyToRest: true,
      onPrompt: () => { promptCount++; },
    });

    // Both entities 409 in PASS 1 and queue up for PASS 2's sequential
    // confirm loop; PASS 2 asks about the first one and pauses there.
    await vi.waitFor(() => expect(promptCount).toBe(1));

    // Unmount while that first prompt is still pending — no decide() will
    // ever be called for it, so the fix has to come from the cleanup itself.
    unmount();

    // The whole point: putDown must resolve (not hang) even though a SECOND
    // entity was still waiting behind the one that got unmount-cancelled.
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled(), { timeout: 2000 });

    // Only ONE prompt ever fired — the fix takes the "apply to the rest"
    // path instead of asking again for entity 2 on a dead component.
    expect(promptCount).toBe(1);

    const result = onSettled.mock.calls[0][0] as PutDownResult;
    expect(result.moved).toEqual([]);
    expect(result.skipped.map((s) => s.id)).toEqual([1, 2]);
    expect(result.aborted).toBe(false);
    expect(result.failedCount).toBe(0);
  });

  it('regression guard — the OLD applyToRest:false behaviour hangs (proves the harness actually detects the bug)', async () => {
    const fetchMock = makeAlways409FetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const load: CarriedItem[] = [
      { id: 1, name: 'Widget A', kind: 'item', fromContainerId: 10 },
      { id: 2, name: 'Widget B', kind: 'item', fromContainerId: 10 },
    ];
    const dest: PutDownTarget = { type: 'container', id: 99, name: 'Bin C' };

    const onSettled = vi.fn();
    let promptCount = 0;
    const { unmount } = renderHarness({
      load, dest, onSettled, unmountApplyToRest: false,
      onPrompt: () => { promptCount++; },
    });

    await vi.waitFor(() => expect(promptCount).toBe(1));
    unmount();

    // Give the (buggy) loop every chance to move on to entity 2 and call
    // confirmPrompt again on the unmounted harness.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    // The loop DID try to prompt again for entity 2 — that second Promise
    // has no resolver anyone will ever call, so putDown never settles.
    expect(promptCount).toBe(2);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
