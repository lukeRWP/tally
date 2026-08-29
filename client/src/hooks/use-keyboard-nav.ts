import { useEffect, useRef } from 'react';

/**
 * Desktop keyboard navigation.
 *
 * A pointer is not the only thing a desk has that a phone does not — it also
 * has a keyboard your hands are already on. Without this, moving through a
 * hundred bins is a hundred round trips to the mouse.
 *
 * Deliberately narrow. These are the four keys people already expect from a
 * list (`/` to search, j/k to move, Enter to open, Escape to back out); a
 * larger set would need teaching, and nothing here teaches it.
 *
 * Keeping the cursor VISIBLE (#235): the hook itself never knows which row is
 * highlighted — every surface owns its own cursor state — so scrolling is a
 * sibling hook plus a markup convention, one shared mechanism for all six
 * wired surfaces:
 *
 *   1. each row (or its wrapper) carries `data-nav-id={id}`, the same id/key
 *      the surface's cursor state tracks;
 *   2. the surface calls `useNavScrollIntoView(highlightedId)` beside its
 *      `useKeyboardNav` call.
 *
 * On every cursor CHANGE the row scrolls into view with `block: 'nearest'`,
 * which respects whatever scroll container the row lives in (root-layout's
 * <main>, the destination picker's own overflow list). The initial mount is
 * deliberately skipped: arriving on a page with a pre-selected row (deep link,
 * Back) is use-scroll-restoration.ts's moment, not this hook's — restoration
 * restores the container's scrollTop via rAF and must not be fought for it.
 */
export interface KeyboardNavOptions {
  /** Move the selection. Not called when nothing is selectable. */
  onMove?: (delta: 1 | -1) => void;
  /**
   * Open whatever is selected. Return true when something was actually
   * opened: the hook preventDefaults the Enter keypress only then (#235), so
   * a Tab-focused control elsewhere cannot double-act on the same press —
   * while an idle ring (nothing highlighted) leaves Enter to whatever is
   * focused, exactly as before.
   */
  onOpen?: () => boolean | void;
  /** Back out: clear the selection, close the panel. */
  onEscape?: () => void;
  /** Focus the page's search field. */
  onSearch?: () => void;
  /** Off in touch chrome, where there is no keyboard to serve. */
  enabled?: boolean;
}

/**
 * Scrolls the row marked `data-nav-id={id}` into view whenever `id` changes.
 *
 * The shared half of the ring's scroll mechanism (see the header comment) —
 * pass the surface's own cursor state (id, key, or null). `block: 'nearest'`
 * means a row already on screen moves nothing at all, so a cursor handed off
 * by a click (matches.tsx's selection sync) is a no-op rather than a jump.
 */
export function useNavScrollIntoView(id: string | number | null | undefined) {
  // Skip the mount: a pre-selected row on arrival belongs to scroll
  // restoration (see header). Only a move made ON this page scrolls.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (id == null) return;
    const el = document.querySelector(`[data-nav-id="${CSS.escape(String(id))}"]`);
    // Optional call: jsdom implements no scrollIntoView, and the existing
    // keyboard suites run every one of these moves without mocking it.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [id]);
}

/**
 * True when the user is typing and a bare letter must stay a letter.
 *
 * Without this, `j` inside the search box moves the list selection and never
 * reaches the input — the single most common way a shortcut layer like this
 * becomes actively hostile.
 */
export function isTyping(target: EventTarget | null): boolean {
  // Partial<HTMLElement>, not HTMLElement: a keydown target is not guaranteed
  // to be an element at all. Casting to HTMLElement told TypeScript every field
  // was present, so returning `el.isContentEditable` — undefined on anything
  // that is not one — type-checked as boolean and was not.
  const el = target as Partial<HTMLElement> | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || el.isContentEditable === true;
}

export function useKeyboardNav({
  onMove, onOpen, onEscape, onSearch, enabled = true,
}: KeyboardNavOptions) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape is the exception: it must work FROM a field, because getting out
      // of one is most of what it is for.
      if (e.key === 'Escape') {
        if (isTyping(e.target)) (e.target as HTMLElement).blur();
        onEscape?.();
        return;
      }

      if (isTyping(e.target)) return;
      // Never swallow a browser or OS shortcut.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case '/':
          if (!onSearch) return;
          e.preventDefault();      // or the '/' lands in the field it just focused
          onSearch();
          break;
        case 'j':
        case 'ArrowDown':
          if (!onMove) return;
          e.preventDefault();      // stop the page scrolling under the selection
          onMove(1);
          break;
        case 'k':
        case 'ArrowUp':
          if (!onMove) return;
          e.preventDefault();
          onMove(-1);
          break;
        case 'Enter':
          if (!onOpen) return;
          // The ring owns Enter only when it actually opened something — a
          // Tab-focused row or button must not fire on the same press (#235).
          // With nothing highlighted, onOpen reports false and the keypress
          // stays the browser's, so focused controls keep working.
          if (onOpen() === true) e.preventDefault();
          break;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onMove, onOpen, onEscape, onSearch, enabled]);
}
