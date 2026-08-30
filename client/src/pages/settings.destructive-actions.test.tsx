// @vitest-environment jsdom
/**
 * #278 — Settings' two irreversible actions (revoke share link, remove
 * printer agent) had no confirm, while the page's one genuinely safe action
 * (Sign Out) was rendered as the loudest, reddest control on the page.
 *
 * This file covers the Settings-page half of the fix:
 *  - Revoking a share link now confirms first (ConfirmDialog, destructive,
 *    naming the irreversibility — no undo, the token can't be reissued) and
 *    only fires the mutation when the confirm button is actually clicked.
 *  - Sign Out drops the destructive/red treatment — signing out destroys
 *    nothing, so it takes the app's neutral `outline` variant instead.
 *
 * Heavy subsystems this page also renders (tags, printer, notifications,
 * property picker) are stubbed to `null`/no-ops — none of them are relevant
 * to either fix, and `properties: []` keeps the property-gated sections
 * (Tags, Printing) from mounting at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SettingsPage } from './settings';
import { useMyShareLinks, useRevokeShareLink } from '@/hooks/use-sharing';

function renderPage() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

vi.mock('@/components/notifications/notification-prefs', () => ({ NotificationPrefs: () => null }));
vi.mock('@/components/print/printer-settings', () => ({ PrinterSettings: () => null }));
vi.mock('@/components/tags/tag-manager', () => ({ TagManager: () => null }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({
    user: { displayName: 'Luke', email: 'luke@example.com', avatarUrl: null },
    theme: 'system',
    setTheme: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-inventory', () => ({
  useProperties: () => ({ data: [] }),
}));

vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: vi.fn(),
  useRevokeShareLink: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const revokeMutation = { mutate: vi.fn(), isPending: false };

const LINK = {
  id: 1,
  token: 'tok_abc',
  entityType: 'item',
  entityId: 42,
  url: 'https://tally.example.com/share/tok_abc',
  expiresAt: '2026-09-05T00:00:00Z',
  createdAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  revokeMutation.mutate = vi.fn();
  revokeMutation.isPending = false;
  vi.mocked(useMyShareLinks).mockReturnValue({ data: [LINK], isLoading: false } as unknown as ReturnType<typeof useMyShareLinks>);
  vi.mocked(useRevokeShareLink).mockReturnValue(revokeMutation as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('Sign Out no longer carries the destructive treatment — it is a neutral outline button', () => {
  renderPage();
  const signOut = screen.getByRole('button', { name: /sign out/i });

  // Destructive's one distinguishing class (solid red fill) must be gone;
  // outline's (transparent fill, ink border) must be present. The safe
  // action reads as a plain secondary button now, not the reddest thing on
  // the page.
  expect(signOut.className).not.toContain('bg-[var(--color-red)]');
  expect(signOut.className).toContain('bg-transparent');
});

test('revoking a share link asks first — the confirm names the irreversibility', () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Revoke the item share link' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Revoke this item link?')).toBeTruthy();
  expect(within(dialog).getByText(/can't be undone/i)).toBeTruthy();
  expect(within(dialog).getByText(/reissued/i)).toBeTruthy();
  expect(revokeMutation.mutate).not.toHaveBeenCalled();
});

test('cancelling the revoke confirm is a no-op', () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Revoke the item share link' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(revokeMutation.mutate).not.toHaveBeenCalled();
});

test('confirming revoke calls the mutation with exactly that link\'s id, once', () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: 'Revoke the item share link' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

  expect(revokeMutation.mutate).toHaveBeenCalledTimes(1);
  expect(revokeMutation.mutate.mock.calls[0][0]).toBe(1);
});
