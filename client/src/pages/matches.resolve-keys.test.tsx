// @vitest-environment jsdom
/**
 * Resolving /matches from the keyboard (#269).
 *
 * The ring shipped able to reach a row and open its panel, and no further:
 * 1/u/y/d/x/Space were all unbound, so every decision on a 30-match backlog
 * was a mouse round trip of ~857px to a target whose y position moves with
 * the candidate count. These tests cover the keys that finish the loop —
 * digits pick the Nth candidate card, `d` is "None of these" — plus the two
 * properties that make them a loop rather than a shortcut: they compose with
 * #228's auto-advance (the same handlers the buttons call), and focus lands
 * on the row the panel advanced TO instead of falling to <body>, which is
 * what made Tab restart 31 stops from the action after every match.
 *
 * What must NOT change is covered next door: matches.advance.test.tsx owns
 * auto-advance and the fresh-rows rule, matches.keyboard-nav.test.tsx owns
 * the id-based cursor and the distinct selection-vs-cursor markers. Nothing
 * here touches either — the keys sit on top of both.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MatchCandidate, ProductMatch } from '@/hooks/use-matches';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { MatchesPage } from './matches';

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
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

let currentRows: ProductMatch[] = [];
let pending = false;
const mutateMock = vi.fn();

vi.mock('@/hooks/use-matches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-matches')>();
  return {
    ...actual,
    useMatches: () => ({ data: currentRows, isLoading: false }),
    useResolveMatch: () => ({ mutate: mutateMock, mutateAsync: vi.fn(), isPending: pending }),
  };
});

function candidate(n: number): MatchCandidate {
  return {
    name: `Widget ${n}`, brand: null, model: null, upc: null, priceUsd: null,
    imageUrl: null, sourceUrl: 'https://example.com/w', sourceDomain: 'example.com',
  };
}

function makeRow(id: number, status: ProductMatch['status'] = 'ready', candidateCount = 1): ProductMatch {
  return {
    id,
    itemId: id * 100,
    itemName: `Item ${id}`,
    containerName: 'Bin',
    status,
    candidates: status === 'ready'
      ? Array.from({ length: candidateCount }, (_, i) => candidate(i + 1))
      : [],
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="url">{location.pathname + location.search}</div>;
}

/** Mirrors ACTION_BURST_MS in use-keyboard-nav.ts. */
const BURST_MS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One keypress at human cadence — silence on both sides of it.
 *
 * The hook fires an action key only when it arrives alone (a barcode scanner
 * is a keyboard that types 12 characters in 50ms; see ACTION_BURST_MS), so a
 * test that means "a person pressed 1" has to leave the window clear on both
 * sides and then let the deferred fire land.
 */
async function press(key: string, init: Record<string, unknown> = {}) {
  await act(async () => { await sleep(BURST_MS + 20); });
  fireEvent.keyDown(window, { key, ...init });
  await act(async () => { await sleep(BURST_MS + 20); });
}

/** A HID scanner emitting a payload: every character inside one window. */
async function scan(payload: string, { suffix = true } = {}) {
  for (const ch of payload) fireEvent.keyDown(window, { key: ch });
  if (suffix) fireEvent.keyDown(window, { key: 'Enter' });   // most scanners send one
  await act(async () => { await sleep(BURST_MS * 3); });
}

function renderMatches(initialEntries: string[] = ['/matches']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/matches" element={<><Probe /><MatchesPage /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  vi.mocked(useLayoutMode).mockReturnValue('sidebar'); // the ring only runs at a desk
  currentRows = [makeRow(1), makeRow(2)];
  pending = false;
  mutateMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The bindings ─────────────────────────────────────────────────────────

test('1 picks the first candidate of the open row — the same call "Use this" makes', async () => {
  renderMatches(['/matches?sel=1']);

  await press('1');

  expect(mutateMock).toHaveBeenCalledTimes(1);
  expect(mutateMock.mock.calls[0][0]).toEqual({ id: 1, candidateIndex: 0 });
});

test('the Nth digit picks the Nth candidate card, in rendered order', async () => {
  currentRows = [makeRow(1, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  await press('3');

  expect(mutateMock.mock.calls[0][0]).toEqual({ id: 1, candidateIndex: 2 });
});

test('a digit past the row\'s own candidate count does nothing — no falling through to a neighbouring meaning', async () => {
  currentRows = [makeRow(1, 'ready', 2)];
  renderMatches(['/matches?sel=1']);

  await press('3');
  await press('9');
  await press('0');

  expect(mutateMock).not.toHaveBeenCalled();
});

test('d dismisses the open row — the same call "None of these" makes', async () => {
  renderMatches(['/matches?sel=1']);

  await press('d');

  expect(mutateMock).toHaveBeenCalledTimes(1);
  expect(mutateMock.mock.calls[0][0]).toEqual({ id: 1, dismiss: true });
});

// ── The guards ───────────────────────────────────────────────────────────

test('the keys are inert while typing — a digit in a field stays a digit', async () => {
  renderMatches(['/matches?sel=1']);
  const field = document.createElement('input');
  document.body.appendChild(field);

  await act(async () => { await sleep(BURST_MS + 20); });
  fireEvent.keyDown(field, { key: '1' });
  await act(async () => { await sleep(BURST_MS + 20); });
  fireEvent.keyDown(field, { key: 'd' });
  await act(async () => { await sleep(BURST_MS + 20); });
  field.remove();

  expect(mutateMock).not.toHaveBeenCalled();
});

test('the keys act on the OPEN row, never the browsing cursor — j to a row does not arm it', async () => {
  renderMatches();

  await press('j');   // cursor on row 1, nothing open
  await press('1');
  await press('d');

  expect(mutateMock).not.toHaveBeenCalled();

  // Enter opens it, and only then do the keys mean anything.
  await press('Enter');
  await press('1');
  expect(mutateMock.mock.calls[0][0]).toEqual({ id: 1, candidateIndex: 0 });
});

test('the keys do nothing on a row that has no decision to make (queued/none)', async () => {
  currentRows = [makeRow(1, 'queued'), makeRow(2, 'failed')];
  renderMatches(['/matches?sel=1']);

  await press('1');
  await press('d');

  expect(mutateMock).not.toHaveBeenCalled();
});

test('the keys are dead while a resolve is in flight, exactly like the disabled buttons', async () => {
  pending = true;
  renderMatches(['/matches?sel=1']);

  await press('1');
  await press('d');

  expect(mutateMock).not.toHaveBeenCalled();
});

test('a held key does not walk down the backlog — auto-repeat is dropped', async () => {
  renderMatches(['/matches?sel=1']);

  await press('d');                        // the deliberate press lands
  expect(mutateMock).toHaveBeenCalledTimes(1);

  // Still holding it: the OS starts repeating. None of those count.
  await press('d', { repeat: true });
  await press('d', { repeat: true });

  expect(mutateMock).toHaveBeenCalledTimes(1);
});

test('the keys are off where there is no keyboard to serve (phone, no split)', async () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderMatches(['/matches?sel=1']);

  await press('1');
  await press('d');

  expect(mutateMock).not.toHaveBeenCalled();
});

// ── The scanner ──────────────────────────────────────────────────────────
// /matches has no text field, so `isTyping` cannot catch a USB scanner here.
// A barcode is a burst of digits aimed straight at the digit bindings.

test('a scanned barcode resolves nothing — the whole burst is refused, first character included', async () => {
  currentRows = [makeRow(1, 'ready', 3), makeRow(2, 'ready', 3), makeRow(3, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  // A UPC that opens on a LIVE digit: under a guard that only rejected keys
  // arriving too soon after the previous one, this leading '1' would have had
  // nothing before it to be measured against, and would have picked a
  // candidate before the rest of the burst was ever seen.
  await scan('123456789012');

  expect(mutateMock).not.toHaveBeenCalled();
});

test('a suffix-less scanner is refused too, including its LAST character', async () => {
  currentRows = [makeRow(1, 'ready', 3), makeRow(2, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  // No trailing Enter (a configurable option on every scanner), and the
  // payload ENDS on a live digit. Nothing follows that '1' to cancel it, so
  // this is the character the burst threshold itself has to refuse — the
  // half of the guard the suffixed cases never exercise.
  await scan('98765431', { suffix: false });

  expect(mutateMock).not.toHaveBeenCalled();
});

test('a scanned tally tag is refused too — the letters in it are part of the same burst', async () => {
  currentRows = [makeRow(1, 'ready', 3), makeRow(2, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  await scan('TLY-I-0002');

  expect(mutateMock).not.toHaveBeenCalled();
});

test('two decisions inside the burst window cancel each other rather than firing twice', async () => {
  currentRows = [makeRow(1, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  await act(async () => { await sleep(BURST_MS + 20); });
  fireEvent.keyDown(window, { key: '1' });
  fireEvent.keyDown(window, { key: '2' });   // 0ms later — not a human deciding twice
  await act(async () => { await sleep(BURST_MS * 3); });

  expect(mutateMock).not.toHaveBeenCalled();
});

test('deliberate presses at human cadence still work, one after another', async () => {
  currentRows = [makeRow(1, 'ready', 3), makeRow(2, 'ready', 3)];
  renderMatches(['/matches?sel=1']);

  await press('2');
  const first = mutateMock.mock.calls[0];
  expect(first[0]).toEqual({ id: 1, candidateIndex: 1 });
  await act(async () => { first[1].onSuccess({ product: null, duplicates: [] }); });

  await press('1');
  expect(mutateMock.mock.calls[1][0]).toEqual({ id: 2, candidateIndex: 0 });
});

// ── The loop ─────────────────────────────────────────────────────────────

test('a keyboard pick auto-advances to the next ready row, exactly as the mouse path does', async () => {
  currentRows = [makeRow(1), makeRow(2)];
  renderMatches(['/matches?sel=1']);

  await press('1');
  const [, opts] = mutateMock.mock.calls[0];
  await act(async () => {
    opts.onSuccess({ product: { id: 9, name: 'Widget', brand: null, barcode: null }, duplicates: [] });
  });

  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=2');
});

test('a keyboard dismiss auto-advances the same way', async () => {
  currentRows = [makeRow(1), makeRow(2)];
  renderMatches(['/matches?sel=1']);

  await press('d');
  const [, opts] = mutateMock.mock.calls[0];
  await act(async () => { opts.onSuccess(undefined); });

  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=2');
});

test('focus lands on the row the panel advanced to, not on <body>', async () => {
  currentRows = [makeRow(1), makeRow(2)];
  renderMatches(['/matches?sel=1']);

  await press('1');
  const [, opts] = mutateMock.mock.calls[0];
  await act(async () => { opts.onSuccess({ product: null, duplicates: [] }); });

  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active?.closest('[data-nav-id]')?.getAttribute('data-nav-id')).toBe('2');
});

test('the whole sitting runs on one keystroke per match', async () => {
  currentRows = [makeRow(1), makeRow(2), makeRow(3)];
  renderMatches(['/matches?sel=1']);

  for (const id of [1, 2]) {
    await press('1');
    const call = mutateMock.mock.calls.at(-1)!;
    expect(call[0]).toEqual({ id, candidateIndex: 0 });
    // The row leaves the worklist, exactly as the refetch would deliver it.
    currentRows = currentRows.filter((r) => r.id !== id);
    await act(async () => { call[1].onSuccess({ product: null, duplicates: [] }); });
  }

  expect(mutateMock).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('url').textContent).toBe('/matches?sel=3');
});

test('a 409 stops the loop rather than advancing over a phantom row', async () => {
  const { ApiError } = await import('@/lib/api');
  currentRows = [makeRow(1), makeRow(2)];
  renderMatches(['/matches?sel=1']);

  await press('1');
  const [, opts] = mutateMock.mock.calls[0];
  await act(async () => { opts.onError(new ApiError('Conflict', 409)); });

  expect(screen.getByTestId('url').textContent).toBe('/matches');
});
