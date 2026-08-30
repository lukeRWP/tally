// @vitest-environment jsdom
/**
 * #295: the ColHead keyboard hint.
 *
 * Six ringed surfaces support j/k, Enter, `/` and Esc, and nothing in the
 * app ever said so. ColHead's opt-in `hint` prop is the fix — but only when
 * there's a keyboard to serve.
 *
 * Until #313, this component ran its own `useCoarsePointer()` check
 * alongside `hint`, because a caller's flag was only ever a layout signal
 * (`wide`/`split`). Now that useKeyboardNav folds the pointer check in at
 * the source and hands callers back its real, pointer-aware state (see
 * use-keyboard-nav.dom.test.tsx and matches.hint.test.tsx, which cover that
 * pointer-awareness end to end through a real ringed page), `hint` IS that
 * state — ColHead trusts it alone, with no pointer check of its own. These
 * tests cover exactly that: `hint` is the single source of truth.
 *
 * No @testing-library/jest-dom in this repo (not installed, no other test
 * uses it), so assertions read raw DOM instead of toBeInTheDocument/etc.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ColHead, KeyCap } from './col-head';

describe('ColHead hint', () => {
  it('shows the hint when opted in', () => {
    render(<ColHead hint>3 results</ColHead>);
    expect(screen.getByText('j k ↵')).toBeTruthy();
  });

  it('stays silent when not opted in', () => {
    render(<ColHead>3 results</ColHead>);
    expect(screen.queryByText('j k ↵')).toBeNull();
  });

  it('stays silent when the caller passes hint={false} — e.g. the ring is live but the pointer is coarse', () => {
    render(<ColHead hint={false}>3 results</ColHead>);
    expect(screen.queryByText('j k ↵')).toBeNull();
  });

  it('renders alongside an action without dropping either', () => {
    render(
      <ColHead hint action="+ Add" onAction={() => {}}>
        Areas · 2
      </ColHead>,
    );
    expect(screen.getByText('j k ↵')).toBeTruthy();
    expect(screen.getByText('+ Add')).toBeTruthy();
  });
});

describe('KeyCap', () => {
  it('renders its label and stays out of the accessibility tree', () => {
    render(<KeyCap>d</KeyCap>);
    const cap = screen.getByText('d');
    expect(cap.getAttribute('aria-hidden')).toBe('true');
  });
});
