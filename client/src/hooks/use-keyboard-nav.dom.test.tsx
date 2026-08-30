// @vitest-environment jsdom
/**
 * The hook-level halves of #235: Enter ownership and the shared scroll
 * mechanism. (isTyping's pure-logic suite stays in use-keyboard-nav.test.ts,
 * node env; these need a window to hang listeners and rows on.)
 *
 * Enter: the ring preventDefaults the keypress ONLY when onOpen reports it
 * actually opened something (returns true). An idle ring — every surface's
 * onOpen returns false with nothing highlighted — must leave Enter to
 * whatever control is focused, or Tab+Enter on any button dies the moment a
 * ring is mounted. preventDefault never stops other listeners, only the
 * browser's default action (the focused element's activation).
 *
 * Scroll: useNavScrollIntoView(id) scrolls the element carrying
 * data-nav-id={id} with block 'nearest' on a cursor MOVE — the round-2 rule
 * is `prev !== null && id !== prev`, so the FIRST non-null id per mount is a
 * silent baseline no matter how many commits late it lands (matches.tsx
 * seeds its cursor from ?sel= one effect AFTER mount; a plain mount-skip was
 * spent on the null commit and let that seed scroll, racing
 * use-scroll-restoration.ts's rAF restore — arrival is restoration's
 * moment). jsdom has no scrollIntoView, so it is mocked onto the prototype
 * here and the hook's own optional call is what keeps unmocked suites alive.
 */
import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  useKeyboardNav, useNavScrollIntoView, type KeyboardNavOptions,
} from './use-keyboard-nav';

function Nav(props: KeyboardNavOptions) {
  useKeyboardNav(props);
  return null;
}

function ScrollProbe({ id }: { id: string | number | null }) {
  useNavScrollIntoView(id);
  return (
    <div>
      <div data-nav-id="container:1" />
      <div data-nav-id="container:2" />
    </div>
  );
}

const scrollSpy = vi.fn();

beforeEach(() => {
  scrollSpy.mockReset();
  Element.prototype.scrollIntoView = scrollSpy;
});

afterEach(() => {
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

// ── Enter ownership ──────────────────────────────────────────────────────

test('Enter is preventDefaulted when the ring opens something (onOpen returns true)', () => {
  const onOpen = vi.fn(() => true);
  render(<Nav onOpen={onOpen} />);

  // fireEvent returns false exactly when preventDefault was called.
  expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(false);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('an idle ring (onOpen returns false) leaves Enter to the focused control', () => {
  render(<Nav onOpen={() => false} />);
  expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true);
});

test('a void-returning onOpen never claims the keypress', () => {
  // The pre-#235 signature — still legal, still un-prevented, so a surface
  // that has not opted in cannot accidentally swallow Enter.
  render(<Nav onOpen={() => { /* returns undefined */ }} />);
  expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true);
});

test('with no onOpen at all, Enter is untouched', () => {
  render(<Nav onMove={() => {}} />);
  expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true);
});

// ── Scroll mechanism ─────────────────────────────────────────────────────

test('a cursor move scrolls the matching data-nav-id row with block nearest', () => {
  // Mounting WITH a cursor (search's render-time ?sel=) is the baseline —
  // arrival belongs to scroll restoration, not this hook.
  const { rerender } = render(<ScrollProbe id="container:1" />);
  expect(scrollSpy).not.toHaveBeenCalled();

  rerender(<ScrollProbe id="container:2" />);

  expect(scrollSpy).toHaveBeenCalledTimes(1);
  expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
  expect(scrollSpy.mock.contexts[0]).toBe(document.querySelector('[data-nav-id="container:2"]'));

  // Moving again scrolls the new row; an unchanged id re-render scrolls nothing.
  rerender(<ScrollProbe id="container:1" />);
  expect(scrollSpy.mock.contexts[1]).toBe(document.querySelector('[data-nav-id="container:1"]'));
  rerender(<ScrollProbe id="container:1" />);
  expect(scrollSpy).toHaveBeenCalledTimes(2);
});

test('round 2: a cursor seeded AFTER mount (matches\' ?sel= sync) is a baseline, not a move', () => {
  // The bug shape: the cursor is null on the mount commit and gets its real
  // id one effect later — exactly matches.tsx's selectedId → highlightedId
  // sync on a fresh /matches?sel=N load.
  function SeededProbe() {
    const [id, setId] = useState<string | null>(null);
    useEffect(() => { setId('container:1'); }, []);
    useNavScrollIntoView(id);
    return (
      <div>
        <button type="button" onClick={() => setId('container:2')}>move</button>
        <div data-nav-id="container:1" />
        <div data-nav-id="container:2" />
      </div>
    );
  }
  render(<SeededProbe />);

  // The seed landed (post-mount) — still no scroll: it is the baseline.
  expect(scrollSpy).not.toHaveBeenCalled();

  // A real move off that baseline scrolls.
  fireEvent.click(screen.getByText('move'));
  expect(scrollSpy).toHaveBeenCalledTimes(1);
  expect(scrollSpy.mock.contexts[0]).toBe(document.querySelector('[data-nav-id="container:2"]'));
});

test('clearing the cursor then landing again re-baselines — no jump on the first landing', () => {
  const { rerender } = render(<ScrollProbe id="container:1" />);
  rerender(<ScrollProbe id="container:2" />);
  expect(scrollSpy).toHaveBeenCalledTimes(1);

  rerender(<ScrollProbe id={null} />);         // Escape clears the ring
  rerender(<ScrollProbe id="container:1" />);  // first landing after the clear
  expect(scrollSpy).toHaveBeenCalledTimes(1);  // baseline again, not a move

  rerender(<ScrollProbe id="container:2" />);  // and moves resume scrolling
  expect(scrollSpy).toHaveBeenCalledTimes(2);
});

test('a move to a cursor with no rendered row is a silent no-op', () => {
  const { rerender } = render(<ScrollProbe id="container:1" />);
  rerender(<ScrollProbe id="item:99" />);
  expect(scrollSpy).not.toHaveBeenCalled();
});

// ── Escape: two jobs, one per press (#271) ───────────────────────────────

test('Escape from a FIELD only blurs — the selection survives the press', () => {
  // The whole defect: /search restores its cursor from ?sel, autoFocus puts
  // focus in the query box, and the only gesture that leaves the box used to
  // clear the cursor in the same handler.
  const onEscape = vi.fn();
  render(<Nav onEscape={onEscape} />);
  const field = document.createElement('input');
  document.body.appendChild(field);
  field.focus();

  fireEvent.keyDown(field, { key: 'Escape' });

  expect(document.activeElement).not.toBe(field);
  expect(onEscape).not.toHaveBeenCalled();

  // Second press, now from outside the field, is the one that backs out.
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onEscape).toHaveBeenCalledTimes(1);

  document.body.removeChild(field);
});

// ── Focus fusion: Tab MOVES the ring (#279) ──────────────────────────────

function FocusProbe({ onFocusRow, enabled = true }: {
  onFocusRow: (navId: string) => void; enabled?: boolean;
}) {
  useKeyboardNav({ onFocusRow, enabled });
  return (
    <div>
      <div data-nav-id="item:601"><button type="button">Row 1</button></div>
      <div data-nav-id="item:620"><button type="button">Row 20</button></div>
      <button type="button">Not a row</button>
    </div>
  );
}

test('focus landing anywhere inside a row hands the ring that row\'s data-nav-id', () => {
  const onFocusRow = vi.fn();
  render(<FocusProbe onFocusRow={onFocusRow} />);

  // The focusable thing is the row's inner button; the marker is on the
  // wrapper — the nearest ancestor carrying one is what counts.
  fireEvent.focusIn(screen.getByText('Row 1'));
  expect(onFocusRow).toHaveBeenCalledWith('item:601');

  fireEvent.focusIn(screen.getByText('Row 20'));
  expect(onFocusRow).toHaveBeenLastCalledWith('item:620');
});

test('a row\'s secondary control (data-nav-ignore) neither moves the ring nor loses Enter', () => {
  // The areas tree's expand chevron: it lives inside a ringed row but is not
  // what the row's Enter means. Fusing from it would move the cursor onto a
  // bin the user was only expanding, and claiming Enter would open that bin
  // instead of expanding it.
  const onFocusRow = vi.fn();
  const onOpen = vi.fn(() => true);
  render(
    <>
      <Nav onFocusRow={onFocusRow} onOpen={onOpen} />
      <div data-nav-id="42">
        <button type="button" data-nav-ignore="">Expand</button>
        <button type="button">Bin 42</button>
      </div>
    </>,
  );

  const chevron = screen.getByText('Expand');
  fireEvent.focusIn(chevron);
  expect(onFocusRow).not.toHaveBeenCalled();

  // Enter stays the chevron's — un-prevented, and the ring never consulted.
  expect(fireEvent.keyDown(chevron, { key: 'Enter' })).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();

  // The row's own button is unaffected on both counts.
  fireEvent.focusIn(screen.getByText('Bin 42'));
  expect(onFocusRow).toHaveBeenCalledWith('42');
  expect(fireEvent.keyDown(screen.getByText('Bin 42'), { key: 'Enter' })).toBe(false);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('focus outside any row leaves the ring alone', () => {
  const onFocusRow = vi.fn();
  render(<FocusProbe onFocusRow={onFocusRow} />);

  fireEvent.focusIn(screen.getByText('Not a row'));
  expect(onFocusRow).not.toHaveBeenCalled();
});

test('focus fusion is off with the rest of the ring (touch chrome)', () => {
  const onFocusRow = vi.fn();
  render(<FocusProbe onFocusRow={onFocusRow} enabled={false} />);

  fireEvent.focusIn(screen.getByText('Row 1'));
  expect(onFocusRow).not.toHaveBeenCalled();
});
