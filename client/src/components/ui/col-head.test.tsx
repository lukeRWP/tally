// @vitest-environment jsdom
/**
 * #295: the ColHead keyboard hint.
 *
 * Six ringed surfaces support j/k, Enter, `/` and Esc, and nothing in the
 * app ever said so. ColHead's opt-in `hint` prop is the fix — but only when
 * there's a keyboard to serve. These tests are the gate itself: `hint` says
 * "this ColHead's rows are ringed", `useCoarsePointer` says "and there's a
 * keyboard here", and only both together may render anything.
 *
 * No matchMedia stub = jsdom's default = useCoarsePointer reads fine-pointer
 * (see use-coarse-pointer.ts and destination-picker.coarse.test.tsx), so the
 * "fine pointer" cases below run with no stubbing at all.
 *
 * No @testing-library/jest-dom in this repo (not installed, no other test
 * uses it), so assertions read raw DOM instead of toBeInTheDocument/etc.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColHead, KeyCap } from './col-head';

function stubPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: coarse,
    media: '(pointer: coarse)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ColHead hint', () => {
  it('shows the hint on a fine pointer when opted in', () => {
    render(<ColHead hint>3 results</ColHead>);
    expect(screen.getByText('j k ↵')).toBeTruthy();
  });

  it('stays silent on a coarse pointer even when opted in', () => {
    stubPointer(true);
    render(<ColHead hint>3 results</ColHead>);
    expect(screen.queryByText('j k ↵')).toBeNull();
  });

  it('stays silent on a fine pointer when the surface does not opt in', () => {
    render(<ColHead>3 results</ColHead>);
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
