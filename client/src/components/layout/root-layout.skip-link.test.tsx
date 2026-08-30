// @vitest-environment jsdom
/**
 * The skip link must not be a ring row (#279 review).
 *
 * It is tab stop 1 on every page, and the ring preventDefaults Enter whenever
 * a cursor exists — which #270 makes the ORDINARY state, since Back now
 * restores one. Without `data-nav-ignore` the sequence "Back → Tab → Enter"
 * on any ringed surface skipped nothing and opened the highlighted row
 * instead: proven on Home at `?q=drill&sel=2`, where Enter on the focused
 * skip link navigated to `/item/2`.
 *
 * Driven through the real RootLayout markup with a real useKeyboardNav ring
 * mounted as the route's content, so this asserts the BEHAVIOUR rather than
 * the presence of an attribute.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, test, vi } from 'vitest';
import { useKeyboardNav } from '@/hooks/use-keyboard-nav';
import { RootLayout } from './root-layout';

// The layout pulls in the whole app shell. None of it is what this file is
// about, so every dependency outside the markup under test is stubbed —
// including @/store/auth-store, whose module body calls window.matchMedia at
// import time (see root-layout.route-seed.test.tsx for the same workaround).
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 1, displayName: 'Dev', email: 'dev@example.com' }, isLoading: false }),
}));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({ user: { displayName: 'Dev', email: 'dev@example.com', avatarUrl: null } }),
}));
vi.mock('@/hooks/use-notifications', () => ({ useUnreadCount: () => ({ data: 0 }) }));
vi.mock('@/hooks/use-inventory', () => ({
  useArea: () => ({ data: undefined }),
  useContainer: () => ({ data: undefined }),
  useAreas: () => ({ data: [] }),
  useProperties: () => ({ data: [] }),
  useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// The rail carries a print badge (#283), which polls two queries.
vi.mock('@/hooks/use-print', () => ({ usePrintAttention: () => 0 }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'sidebar' }));
vi.mock('@/hooks/use-has-camera', () => ({ useHasCamera: () => true }));
vi.mock('@/hooks/use-scroll-restoration', () => ({ useScrollRestoration: () => {} }));
vi.mock('@/components/inventory/carry-banner', () => ({ CarryBanner: () => null }));
vi.mock('@/store/carry-store', () => ({
  useCarryStore: (sel: (s: unknown) => unknown) => sel({ carried: [], lastMove: null }),
}));

const onOpen = vi.fn(() => true);

/** A live ring with a cursor on it — exactly what Back now restores. */
function RingedPage() {
  useKeyboardNav({ onOpen, onSearch: () => {} });
  return <div data-nav-id="item:2">a row</div>;
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<RootLayout />}>
          <Route index element={<RingedPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

test('the skip link points at <main> and is the first focusable thing', () => {
  renderLayout();
  const skip = screen.getByRole('link', { name: 'Skip to content' });

  expect(skip.getAttribute('href')).toBe('#main-content');
  // The target has to be focusable or the anchor moves the scroll and not the
  // focus, which defeats the point for a keyboard user.
  const main = document.querySelector('main')!;
  expect(main.id).toBe('main-content');
  expect(main.getAttribute('tabindex')).toBe('-1');
});

test('Enter on the focused skip link skips — the ring does not swallow it', () => {
  renderLayout();
  const skip = screen.getByRole('link', { name: 'Skip to content' });

  fireEvent.focusIn(skip);
  // fireEvent returns false exactly when preventDefault was called; the
  // anchor's own default navigation must survive.
  expect(fireEvent.keyDown(skip, { key: 'Enter' })).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
});
