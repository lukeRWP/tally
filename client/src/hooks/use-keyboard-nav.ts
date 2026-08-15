import { useEffect } from 'react';

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
 */
export interface KeyboardNavOptions {
  /** Move the selection. Not called when nothing is selectable. */
  onMove?: (delta: 1 | -1) => void;
  /** Open whatever is selected. */
  onOpen?: () => void;
  /** Back out: clear the selection, close the panel. */
  onEscape?: () => void;
  /** Focus the page's search field. */
  onSearch?: () => void;
  /** Off in touch chrome, where there is no keyboard to serve. */
  enabled?: boolean;
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
          onOpen();
          break;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onMove, onOpen, onEscape, onSearch, enabled]);
}
