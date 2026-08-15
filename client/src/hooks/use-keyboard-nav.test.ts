import { describe, it, expect } from 'vitest';
import { isTyping } from './use-keyboard-nav';

/**
 * The single property that decides whether a shortcut layer helps or actively
 * fights the user: a bare letter must stay a letter while they are typing.
 *
 * Get this wrong and `j` in the search box moves the list selection and never
 * reaches the input — the field silently drops characters, which reads as the
 * app being broken rather than as a shortcut misfiring.
 */
const el = (tag: string, contentEditable = false) =>
  ({ tagName: tag, isContentEditable: contentEditable }) as unknown as EventTarget;

describe('isTyping', () => {
  it('is true for every field a character can land in', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTyping(el(tag)), `${tag} would swallow keystrokes`).toBe(true);
    }
    expect(isTyping(el('DIV', true)), 'contenteditable is still typing').toBe(true);
  });

  it('is false for the things a shortcut should act on', () => {
    for (const tag of ['DIV', 'BUTTON', 'BODY', 'A', 'LI']) {
      expect(isTyping(el(tag)), `${tag} should not block shortcuts`).toBe(false);
    }
  });

  it('does not throw on a null or exotic target', () => {
    // keydown can fire with target null during teardown; a throw here would
    // take down the whole listener and silently kill every shortcut.
    expect(isTyping(null)).toBe(false);
    expect(isTyping({} as EventTarget)).toBe(false);
  });
});
