// @vitest-environment jsdom
/**
 * #315: keyboard focus on a row must look focused.
 *
 * `focus-visible:bg-[var(--color-elevated)]` used to be the ENTIRE focus
 * indicator, and that class is also `active:`'s press feedback — a
 * Tab-focused row and a row mid-click rendered identically, on a background
 * only 0.027 lightness away from the page itself. The fix borrows
 * button.tsx's ring pattern (ring-2 ring-primary) instead of inventing one,
 * but inset rather than offset, because ruled rows sit flush against each
 * other with no gap for an outside ring to occupy.
 *
 * No @testing-library/jest-dom in this repo, so class membership is read
 * off `className` directly (see col-head.test.tsx for the same pattern).
 *
 * "Cursor" (the keyboard-nav ring: `bg-[var(--color-elevated)]` + `ring-1
 * ring-[var(--color-text)]`) and "selected" (RuledRow's own checkbox state:
 * `bg-[var(--color-primary-bg)]`) are both applied as plain background/ring
 * utilities with no `focus-visible:` prefix, so they are always-on rather
 * than conditional on pseudo-class — this file locks in that RuledRow's OWN
 * focus-visible declaration never reuses either of those classes, which is
 * what let all three collapse into one look before.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RuledRow } from './ruled-row';

describe('RuledRow focus', () => {
  it('gives an interactive (navigate) row a visible focus ring, not the pressed tint', () => {
    render(<RuledRow title="Cordless Drill" onNavigate={() => {}} />);
    const row = screen.getByRole('button', { name: 'Cordless Drill' });
    const cls = row.className;

    expect(cls).toContain('focus-visible:ring-2');
    expect(cls).toContain('focus-visible:ring-inset');
    expect(cls).toContain('focus-visible:ring-[var(--color-primary)]');
    expect(cls).toContain('focus-visible:outline-none');
    // The bug: focus used to BE the elevated tint. It may still appear as
    // the active/hover tint (unrelated to focus-visible), but never behind
    // a `focus-visible:` prefix.
    expect(cls).not.toContain('focus-visible:bg-[var(--color-elevated)]');
  });

  it('gives a selectable row the same ring, layered over its own selected tint', () => {
    render(
      <RuledRow
        title="Cordless Drill"
        selectable
        selected
        selectLabel="Select Cordless Drill"
        onToggle={() => {}}
      />,
    );
    const row = screen.getByRole('button', { name: 'Select Cordless Drill' });
    const cls = row.className;

    // Selected tint (independent of focus) is still there…
    expect(cls).toContain('bg-[var(--color-primary-bg)]');
    // …and the focus ring is a DIFFERENT declaration, not a class that
    // collides with — or substitutes for — the selected tint.
    expect(cls).toContain('focus-visible:ring-[var(--color-primary)]');
    expect(cls).not.toContain('focus-visible:bg-[var(--color-primary-bg)]');
    expect(cls).not.toContain('focus-visible:bg-[var(--color-elevated)]');
  });

  it('gives a non-interactive row (no onNavigate, not selectable) no focus styling at all', () => {
    render(<RuledRow title="Read-only row" />);
    const row = screen.getByText('Read-only row').closest('div');
    expect(row?.tagName).toBe('DIV');
    expect(row?.className).not.toContain('focus-visible');
  });
});
