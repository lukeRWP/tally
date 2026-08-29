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
 * data-nav-id={id} with block 'nearest' on every CHANGE of id — never on
 * mount (arrival scroll belongs to use-scroll-restoration.ts). jsdom has no
 * scrollIntoView, so it is mocked onto the prototype here and the hook's own
 * optional call is what keeps unmocked suites alive.
 */
import { fireEvent, render } from '@testing-library/react';
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

test('a cursor change scrolls the matching data-nav-id row with block nearest', () => {
  const { rerender } = render(<ScrollProbe id={null} />);
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

test('mounting with a cursor already set scrolls nothing — arrival belongs to scroll restoration', () => {
  render(<ScrollProbe id="container:1" />);
  expect(scrollSpy).not.toHaveBeenCalled();
});

test('a cursor pointing at no rendered row is a silent no-op', () => {
  const { rerender } = render(<ScrollProbe id={null} />);
  rerender(<ScrollProbe id="item:99" />);
  expect(scrollSpy).not.toHaveBeenCalled();
});
