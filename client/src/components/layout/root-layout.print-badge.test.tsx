// @vitest-environment jsdom
/**
 * #283 — the rail surfaced one of the app's three global states. Carrying gets
 * a docked panel (carry-banner.tsx) and alerts get a count; printing got
 * nothing, because the badge was gated on `item.path === '/notifications'`.
 * Driven with a stopped agent and a failed job, every nav row's extra span was
 * empty while `/print` itself shouted "OUT OF LABELS" once you went to look.
 *
 * Auto-print is a queue-it-and-walk-away flow, so "nothing printed for two
 * days" was discovered by chance. `printAttentionCount` (use-print.test.ts)
 * decides WHEN; this file pins that the rail actually shows it, and that the
 * count is legible to a screen reader rather than being a bare digit.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { RootLayout } from './root-layout';

let attention = 0;
let unread = 0;

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 1, displayName: 'Dev', email: 'dev@example.com' }, isLoading: false }),
}));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({ user: { displayName: 'Dev', email: 'dev@example.com', avatarUrl: null } }),
}));
vi.mock('@/hooks/use-notifications', () => ({ useUnreadCount: () => ({ data: unread }) }));
vi.mock('@/hooks/use-inventory', () => ({
  useArea: () => ({ data: undefined }),
  useContainer: () => ({ data: undefined }),
  useAreas: () => ({ data: [] }),
  useProperties: () => ({ data: [{ id: 1, name: 'Rockwood' }] }),
  useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/use-print', () => ({ usePrintAttention: () => attention }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'sidebar' }));
vi.mock('@/hooks/use-has-camera', () => ({ useHasCamera: () => true }));
vi.mock('@/hooks/use-scroll-restoration', () => ({ useScrollRestoration: () => {} }));
vi.mock('@/components/inventory/carry-banner', () => ({ CarryBanner: () => null }));
vi.mock('@/store/carry-store', () => ({
  useCarryStore: (sel: (s: unknown) => unknown) => sel({ carried: [], lastMove: null }),
}));

beforeEach(() => {
  attention = 0;
  unread = 0;
});

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<RootLayout />}>
          <Route index element={<div />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The rail row whose label starts with `name`. Start-anchored rather than
 * exact: a badged row's accessible name carries the badge's spoken text too,
 * which is the point of the badge.
 */
function navRow(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`, 'i') });
}

test('a quiet print queue puts no badge on the rail', () => {
  renderLayout();
  expect(navRow('Print').textContent).toBe('Print');
});

test('jobs needing attention badge the Print row', () => {
  attention = 2;
  renderLayout();
  expect(navRow('Print').textContent).toContain('2');
});

test('the count says what it counts — "Print 2" alone means nothing aloud', () => {
  attention = 2;
  renderLayout();
  expect(navRow('Print').textContent).toContain('2 needing attention');
});

test('alerts keep their own badge, unchanged', () => {
  unread = 3;
  renderLayout();
  expect(navRow('Alerts').textContent).toContain('3');
  expect(navRow('Alerts').textContent).toContain('3 unread');
});

test('both states can be live at once without either shadowing the other', () => {
  attention = 1;
  unread = 5;
  renderLayout();
  expect(navRow('Print').textContent).toContain('1');
  expect(navRow('Alerts').textContent).toContain('5');
});

test('a big backlog is capped rather than widening the rail', () => {
  attention = 150;
  renderLayout();
  const row = navRow('Print');
  expect(row.textContent).toContain('99+');
  // The spoken form keeps the true number.
  expect(row.textContent).toContain('150 needing attention');
});

test('no other row gains a badge', () => {
  attention = 2;
  unread = 1;
  renderLayout();
  for (const name of ['Search', 'Home', 'Areas', 'Scan', 'Reports', 'Settings']) {
    expect(navRow(name).textContent).toBe(name);
  }
});
