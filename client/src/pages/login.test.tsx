// @vitest-environment jsdom
/**
 * #283 — sign-in had no failure path at all.
 *
 * `auth.routes.js` has always redirected a failed OAuth callback to
 * `/login?error=auth_failed`, and this page had no error branch: the user saw
 * "Signing in…", then the sign-in button again, with nothing said. Reported in
 * the review as code-traced rather than driven, because the harness always has
 * a session — these tests drive it.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { Login } from './login';

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Login /></MemoryRouter>);
}

test('a clean visit says nothing about errors', () => {
  renderAt('/login');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /sign in with microsoft/i })).toBeTruthy();
});

test('the server\'s auth_failed is explained, not swallowed', () => {
  renderAt('/login?error=auth_failed');

  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/couldn't sign you in/i);
  // And the way out is still right there, enabled.
  const button = screen.getByRole('button', { name: /sign in with microsoft/i }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
});

test('a cancelled sign-in reads as a cancellation, not a fault', () => {
  renderAt('/login?error=access_denied');
  expect(screen.getByRole('alert').textContent).toMatch(/cancelled/i);
});

test('an error code nobody anticipated still gets a sentence, and carries the code', () => {
  renderAt('/login?error=interaction_required');

  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/didn't complete/i);
  expect(alert.textContent).toContain('interaction_required');
});

test('the message is an alert, so it is announced on a page reached BY a redirect', () => {
  renderAt('/login?error=auth_failed');
  expect(screen.getByRole('alert')).toBeTruthy();
});
