// @vitest-environment jsdom
/**
 * /print becoming a batch surface like its three siblings (#281).
 *
 * Before this: the staged "Ready to print" list had no selection idiom at
 * all (trimming a batch cost one click per row on a 38×32px X), stretched
 * to a single full-width column, buried its send button at the bottom of a
 * 50-row list, and showed a bare "Sending…" with no `N of M` counter.
 *
 * This covers the two behavioural additions: select mode's bulk Remove
 * (mirrors recycle-bin-list.tsx's one-action select bar) and the `N of M`
 * progress counter during a send (mirrors matches.tsx/container-detail's
 * `Clearing…`/`Deleting…` counters). The store is real zustand (matches
 * how the rest of this codebase tests it — no other test in the repo mocks
 * print-queue-store), seeded directly via `setState` before each test.
 *
 * No @testing-library/jest-dom in this repo (see container-detail.bulk.test.tsx),
 * so assertions read raw DOM properties instead of `toHaveTextContent`/`toBeDisabled`.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { usePrintQueueStore } from '@/store/print-queue-store';
import type { StagedLabel } from '@/store/print-queue-store';
import type { Printer, PrintJob } from '@/hooks/use-print';
import { useBottomBarStore } from '@/store/bottom-bar-store';
import { PrintQueuePage } from './print-queue';

// PrintQueuePage now reads useCarryBannerShowing() (use-bottom-stack.ts),
// which calls useLocation() unconditionally — needs a Router, same as
// recycle-bin-list.test.tsx's renderWith.
function renderPage() {
  return render(
    <MemoryRouter>
      <PrintQueuePage />
    </MemoryRouter>,
  );
}

// jsdom has no matchMedia; container-detail.bulk.test.tsx stubs the same way.
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));

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

const toastMock = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

const cancelMutation = { mutate: vi.fn(), isPending: false };
const retryMutation = { mutate: vi.fn(), isPending: false };
const setLoadedMediaMutation = { mutate: vi.fn(), isPending: false };
const createJobMutateAsync = vi.fn();

vi.mock('@/hooks/use-print', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-print')>();
  return {
    ...actual,
    usePrinters: () => ({
      data: [{
        id: 1, propertyId: 1, name: 'Garage Pi', loadedMedia: 'small',
        printerState: 'idle', printerStateReasons: [], lastSeenAt: new Date().toISOString(),
      } satisfies Printer],
      isLoading: false, isError: false,
    }),
    usePrintJobs: () => ({ data: [] as PrintJob[] }),
    useCreatePrintJob: () => ({ mutateAsync: createJobMutateAsync, isPending: false }),
    useCancelPrintJob: () => cancelMutation,
    useRetryPrintJob: () => retryMutation,
    useSetLoadedMedia: () => setLoadedMediaMutation,
  };
});

function label(over: Partial<StagedLabel> & { id: number; name: string }): StagedLabel {
  return {
    key: `item:${over.id}`, entityType: 'item', qrCode: `TLY-I-${over.id}`,
    propertyId: 1, preset: 'small', ...over,
  };
}

function seedStaged(labels: StagedLabel[]) {
  usePrintQueueStore.setState({ staged: labels });
}

/** A promise this test controls the settlement of, to inspect mid-run state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrintQueueStore.setState({ staged: [] });
  useBottomBarStore.setState({ bars: {} });
});

afterEach(() => {
  usePrintQueueStore.setState({ staged: [] });
  useBottomBarStore.setState({ bars: {} });
});

test('Select mode adds checkboxes and a bulk Remove that drops exactly the selected rows', () => {
  seedStaged([
    label({ id: 1, name: 'Item One' }),
    label({ id: 2, name: 'Item Two' }),
    label({ id: 3, name: 'Item Three' }),
  ]);
  renderPage();

  // No selection idiom at all was the headline defect — before Select is
  // clicked there is nothing to toggle.
  expect(screen.queryByLabelText('Select Item One')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  const rowOne = screen.getByLabelText('Select Item One');
  const rowTwo = screen.getByLabelText('Select Item Two');
  expect(rowOne.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(rowOne);
  fireEvent.click(rowTwo);
  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(rowOne.getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));

  expect(toastMock).toHaveBeenCalledWith('Removed 2');
  // Exactly the untouched row survives — this used to cost 2 individual
  // 38×32px X clicks instead of one bulk action.
  expect(usePrintQueueStore.getState().staged.map((l) => l.name)).toEqual(['Item Three']);
  // Select mode exits once the trim is done, same as container-detail's
  // handleAddSelected/handleMoveSelected.
  expect(screen.queryByLabelText('Select Item Three')).toBeNull();
});

test('per-row controls disappear while selecting so a tap cannot fire two actions at once', () => {
  seedStaged([label({ id: 1, name: 'Item One' })]);
  renderPage();

  // Two "2×1" buttons exist before selecting: the printer's own Loaded Roll
  // picker up top, plus this row's preset picker.
  expect(screen.getAllByRole('button', { name: '2×1' }).length).toBe(2);

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  // The row's own preset buttons and its remove-X are both real nested
  // buttons, hidden while selecting so a tap can't fire the row's toggle
  // AND a button at once — back down to 1 (the printer's Loaded Roll
  // picker) plus the select-mode bar's own scoped roll setter = 2.
  expect(screen.getAllByRole('button', { name: '2×1' }).length).toBe(2);
});

test('select-mode roll setter retargets exactly the selected rows, leaving the rest untouched', () => {
  seedStaged([
    label({ id: 1, name: 'Item One', preset: 'small' }),
    label({ id: 2, name: 'Item Two', preset: 'small' }),
    label({ id: 3, name: 'Item Three', preset: 'small' }),
  ]);
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByLabelText('Select Item One'));
  fireEvent.click(screen.getByLabelText('Select Item Two'));

  // Scope to the select-mode bar itself — the printer's own Loaded Roll
  // picker up top also has a "3×3" button, and it's never disabled.
  const bar = screen.getByText('2 selected').closest('div')!;
  fireEvent.click(within(bar).getByRole('button', { name: '3×3' }));

  const presets = Object.fromEntries(
    usePrintQueueStore.getState().staged.map((l) => [l.name, l.preset]),
  );
  // Exactly the two selected rows retargeted — "Set all to" above the list
  // is unscoped and untouched by this; this is the only way to retarget a
  // SUBSET, since per-row preset buttons are hidden while selecting.
  expect(presets).toEqual({ 'Item One': 'medium', 'Item Two': 'medium', 'Item Three': 'small' });
});

test('a send shows a truthful N of M counter instead of a bare "Sending…"', async () => {
  seedStaged([
    label({ id: 1, name: 'Item One' }),
    label({ id: 2, name: 'Item Two' }),
    label({ id: 3, name: 'Bin One', entityType: 'container', key: 'container:3', preset: 'medium' }),
  ]);
  const first = deferred<{ id: number; status: string }>();
  const second = deferred<{ id: number; status: string }>();
  createJobMutateAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  renderPage();

  const sendButton = screen.getByRole('button', { name: /label/ });
  expect(sendButton.textContent).toContain('Print 3 labels');

  fireEvent.click(sendButton);

  // Before either request settles: the two 'item' labels bucket into one
  // group, the container into another — nothing has landed yet.
  await waitFor(() => expect(createJobMutateAsync).toHaveBeenCalledTimes(1));
  expect(sendButton.textContent).toContain('Sending… 0 of 3');
  expect((sendButton as HTMLButtonElement).disabled).toBe(true);

  await act(async () => { first.resolve({ id: 10, status: 'queued' }); });
  await waitFor(() => expect(createJobMutateAsync).toHaveBeenCalledTimes(2));
  // First group (the 2 items) landed — the counter moved, unlike the old
  // bare "Sending…" that gave no sign anything was happening.
  expect(sendButton.textContent).toContain('Sending… 2 of 3');

  await act(async () => { second.resolve({ id: 11, status: 'queued' }); });
  await waitFor(() => expect(usePrintQueueStore.getState().staged.length).toBe(0));

  expect(toastMock).toHaveBeenCalledWith('Printing 3 labels');
});

// ── #302: registration must match whichever bar is actually rendered ──────

test('#302: the printer-ready send bar registers on staged alone, before Select is ever touched', () => {
  seedStaged([label({ id: 1, name: 'Item One' })]);
  renderPage();

  // Not selecting yet — the pinned send bar is the one on screen, gated on
  // `staged.length > 0` alone. Registration must already reflect that.
  expect(screen.queryByText(/^\d+ selected$/)).toBeNull();
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(1);
});

test('#302: Clear (reachable WHILE selecting, :362) must not drop registration a tick before the select bar itself disappears', () => {
  seedStaged([label({ id: 1, name: 'Item One' })]);
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.getByText('0 selected')).toBeTruthy();
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(1);

  // Passive effects run strictly after the commit that produced whatever is
  // currently on screen, so checking the DOM at the exact moment the shared
  // store reports "nothing registered" is a true "was the bar still up when
  // clearance dropped" check — not a guess about React's internal timing.
  // The old `staged.length > 0` condition flips to false the instant
  // `clearStaged()` empties the array — one commit before `selecting` itself
  // catches up via the auto-exit effect (:142-145) — unregistering while the
  // select bar (gated only on `selecting`, :542) is still what's rendered.
  let unregisteredWhileBarStillOnScreen = false;
  const unsub = useBottomBarStore.subscribe((s) => {
    if (Object.keys(s.bars).length === 0 && screen.queryByText(/^\d+ selected$/)) {
      unregisteredWhileBarStillOnScreen = true;
    }
  });

  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  unsub();

  expect(unregisteredWhileBarStillOnScreen).toBe(false);

  // Everything settles correctly once the tick completes: no staged rows,
  // select mode auto-exits (the pre-existing behaviour this fix must not
  // disturb), and nothing is left registered.
  expect(usePrintQueueStore.getState().staged).toEqual([]);
  expect(screen.queryByText(/^\d+ selected$/)).toBeNull();
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(0);
});

test('#302 twin: "Remove failed" (:355, also reachable while selecting) has the same one-tick hazard and must not drop registration early either', async () => {
  seedStaged([label({ id: 1, name: 'Item One' }), label({ id: 2, name: 'Item Two' })]);
  createJobMutateAsync.mockRejectedValue(new Error('boom'));
  renderPage();

  // Rig a failed send so "Remove failed" appears, then re-enter selecting —
  // the button is not gated on `!selecting` any more than Clear is.
  fireEvent.click(screen.getByRole('button', { name: /label/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Remove failed/ })).toBeTruthy());

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(1);

  let unregisteredWhileBarStillOnScreen = false;
  const unsub = useBottomBarStore.subscribe((s) => {
    if (Object.keys(s.bars).length === 0 && screen.queryByText(/^\d+ selected$/)) {
      unregisteredWhileBarStillOnScreen = true;
    }
  });

  fireEvent.click(screen.getByRole('button', { name: /Remove failed/ }));
  unsub();

  expect(unregisteredWhileBarStillOnScreen).toBe(false);
  expect(usePrintQueueStore.getState().staged).toEqual([]);
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(0);
});
