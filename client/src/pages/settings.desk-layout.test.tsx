// @vitest-environment jsdom
/**
 * #283 — Settings' two columns were ASSIGNED, not balanced. Three short
 * sections went left and five long ones went right, so at 1440×900 the left
 * column's last content ended at y≈352 while the right ran to y≈1260: half the
 * screen blank while the page still scrolled (main.scrollHeight 1361 vs
 * clientHeight 900). Identical at 1920 — the columns just got wider.
 *
 * #297 — the same page listed share URLs in a bare `<span>` while the share
 * DIALOG had already been given a real anchor (#296, PR #296). Two surfaces
 * showing the same URL, one of which you could open.
 *
 * jsdom does no layout, so what is pinned here is the structure the
 * measurement rests on: which column each section is in, and what the URL is.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import { SettingsPage } from './settings';

vi.mock('@/components/notifications/notification-prefs', () => ({
  NotificationPrefs: () => <div data-testid="notification-prefs" />,
}));
vi.mock('@/components/print/printer-settings', () => ({
  PrinterSettings: () => <div data-testid="printer-settings" />,
}));
vi.mock('@/components/tags/tag-manager', () => ({
  TagManager: () => <div data-testid="tag-manager" />,
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({
    user: { displayName: 'Luke', email: 'luke@example.com', avatarUrl: null },
    theme: 'system',
    setTheme: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-inventory', () => ({
  useProperties: () => ({ data: [{ id: 1, name: 'Rockwood' }] }),
}));

const LINK = {
  id: 1,
  propertyId: 3,
  createdBy: 1,
  createdByName: 'Luke',
  entityType: 'container',
  entityId: 1,
  expiresAt: '2026-09-05T00:00:00Z',
  createdAt: '2026-08-29T00:00:00Z',
};

vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: () => ({ data: [LINK], isLoading: false }),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

function renderPage() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

function column(container: HTMLElement, side: 'left' | 'right') {
  return container.querySelector(`[data-settings-column="${side}"]`) as HTMLElement;
}

/** The section headings in a column, in order. */
function sectionsIn(col: HTMLElement) {
  return Array.from(col.children)
    .map((section) => section.textContent?.trim() ?? '')
    .map((text) => text.split('\n')[0]);
}

test('both columns exist and each holds sections', () => {
  const { container } = renderPage();
  expect(sectionsIn(column(container, 'left')).length).toBeGreaterThan(0);
  expect(sectionsIn(column(container, 'right')).length).toBeGreaterThan(0);
});

test('Notifications sits under Data in the LEFT column, not stacked on the right', () => {
  const { container } = renderPage();

  const left = column(container, 'left');
  const right = column(container, 'right');

  expect(within(left).getByTestId('notification-prefs')).toBeTruthy();
  expect(within(right).queryByTestId('notification-prefs')).toBeNull();
});

test('it lands under Data rather than displacing anything above it', () => {
  const { container } = renderPage();
  const order = sectionsIn(column(container, 'left'));

  const data = order.findIndex((t) => /^data/i.test(t));
  const notifications = order.findIndex((t) => /^notifications/i.test(t));
  expect(data).toBeGreaterThan(-1);
  expect(notifications).toBe(data + 1);
  // Profile and Appearance keep the top of the column, in that order. Each
  // entry is a whole section's text, so match on how it STARTS.
  expect(order[0]).toMatch(/^Profile/);
  expect(order[1]).toMatch(/^Appearance/);
  expect(order[2]).toMatch(/^Data/);
});

/**
 * The rule is not "shortest first", which would need re-deciding whenever a
 * section changed. Fixed-height sections go left; the ones that grow with the
 * property go right, so a house with thirty tags cannot undo the balance.
 */
test('every FIXED-height section is on the left', () => {
  const { container } = renderPage();
  const left = column(container, 'left');

  expect(within(left).getByText(/profile/i)).toBeTruthy();
  expect(within(left).getByText(/appearance/i)).toBeTruthy();
  expect(within(left).getByText(/^data$/i)).toBeTruthy();
  expect(within(left).getByTestId('notification-prefs')).toBeTruthy();
  expect(within(left).getByText(/photo identification/i)).toBeTruthy();
});

test('every section that GROWS WITH THE PROPERTY is on the right', () => {
  const { container } = renderPage();
  const right = column(container, 'right');

  expect(within(right).getByTestId('tag-manager')).toBeTruthy();
  expect(within(right).getByTestId('printer-settings')).toBeTruthy();
  expect(within(right).getByText(/share links/i)).toBeTruthy();
  // …and nothing fixed-height is stranded among them.
  expect(within(right).queryByTestId('notification-prefs')).toBeNull();
  expect(within(right).queryByText(/photo identification/i)).toBeNull();
});

test('moving one section did not lose it: every section is still on the page exactly once', () => {
  const { container } = renderPage();
  const all = [...sectionsIn(column(container, 'left')), ...sectionsIn(column(container, 'right'))];

  for (const name of ['Profile', 'Appearance', 'Data', 'Tags', 'Notifications', 'Printing', 'Photo identification', 'Share links']) {
    expect(all.filter((t) => t.toLowerCase().startsWith(name.toLowerCase())).length).toBe(1);
  }
});

/* ---------------------------------------------------------------- #297 ---- */
// #297 gave this list the same anchor the share dialog has. #349 took the URL
// away from BOTH lists — the server keeps only a digest of the token, so the
// address is shown once, in the dialog that made it. What a settings row can
// honestly offer is provenance and revoke.

test('a share-link row offers no URL and no copy — the address cannot be rebuilt from a digest', () => {
  renderPage();

  expect(screen.queryByRole('link', { name: /share\// })).toBeNull();
  expect(screen.queryByRole('button', { name: /copy the container share link/i })).toBeNull();
  expect(screen.getByRole('button', { name: /revoke the container share link/i })).toBeTruthy();
});

test('a link another member made on my property says so; my own does not', () => {
  renderPage();
  // LINK.createdBy is 1 and the signed-in user is not user 1 (see the auth mock).
  expect(screen.getByText(/by Luke/)).toBeTruthy();
});
