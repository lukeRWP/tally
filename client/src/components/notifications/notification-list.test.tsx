// @vitest-environment jsdom
/**
 * Alerts return-to-list + bulk dismiss (#229).
 *
 * Two changes to the notification list:
 *  - Clicking into an entity now carries {state:{from:'alerts'}} (the back
 *    link itself renders on the shared Breadcrumbs component — see
 *    breadcrumbs.test.tsx).
 *  - "Dismiss N" loops the existing single-dismiss endpoint sequentially,
 *    continue-on-failure, with a truthful outcome toast and a disabled
 *    button + progress label while running (mark-all-read is untouched).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Notification } from '@/hooks/use-notifications';
import { NotificationList } from './notification-list';

const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

const markReadMock = vi.fn();
const markAllReadMock = vi.fn();
const dismissMock = vi.fn();

function makeNotification(over: Partial<Notification> & { id: number }): Notification {
  return {
    type: 'custom_date',
    title: `Notification ${over.id}`,
    message: 'Something happened',
    entityType: 'item',
    entityId: over.id,
    readAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

let notifications: Notification[] = [];

vi.mock('@/hooks/use-notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-notifications')>();
  return {
    ...actual,
    useNotifications: () => ({ data: notifications, isLoading: false }),
    useMarkRead: () => ({ mutate: markReadMock, isPending: false }),
    useMarkAllRead: () => ({ mutate: markAllReadMock, isPending: false }),
    useDismissNotification: () => ({ mutate: dismissMock, mutateAsync: dismissMock, isPending: false }),
  };
});

function renderList() {
  return render(
    <MemoryRouter>
      <NotificationList />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateSpy.mockClear();
  toastMock.mockClear();
  markReadMock.mockClear();
  markAllReadMock.mockClear();
  dismissMock.mockReset().mockResolvedValue({});
  notifications = [
    makeNotification({ id: 1, title: 'Widget A due' }),
    makeNotification({ id: 2, title: 'Widget B due' }),
    makeNotification({ id: 3, title: 'Widget C due' }),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('clicking a notification with an entity navigates with {state:{from:"alerts"}}', () => {
  renderList();
  fireEvent.click(screen.getByText('Widget A due'));
  expect(navigateSpy).toHaveBeenCalledWith('/item/1', { state: { from: 'alerts' } });
});

// #237 — item_date/item_lending stamp the *source-row* id as entityId (dedup
// key); the server now projects the owning item as itemId at read time. The
// click must land on the item, carrying the same alerts back-state.

test('an item_date notification with itemId navigates to its item with the alerts state', () => {
  notifications = [makeNotification({
    id: 10, title: 'Warranty due', entityType: 'item_date', entityId: 9, itemId: 77,
  })];
  renderList();
  fireEvent.click(screen.getByText('Warranty due'));
  expect(navigateSpy).toHaveBeenCalledWith('/item/77', { state: { from: 'alerts' } });
});

test('an item_lending notification with itemId navigates to its item with the alerts state', () => {
  notifications = [makeNotification({
    id: 11, title: 'Drill overdue', type: 'lending_due', entityType: 'item_lending', entityId: 5, itemId: 88,
  })];
  renderList();
  fireEvent.click(screen.getByText('Drill overdue'));
  expect(navigateSpy).toHaveBeenCalledWith('/item/88', { state: { from: 'alerts' } });
});

test('an item_date notification without itemId (deleted source row / old API) falls back to Home', () => {
  notifications = [makeNotification({
    id: 12, title: 'Orphaned date', entityType: 'item_date', entityId: 999, itemId: null,
  })];
  renderList();
  fireEvent.click(screen.getByText('Orphaned date'));
  expect(navigateSpy).toHaveBeenCalledWith('/', { state: { from: 'alerts' } });
});

test('"Dismiss 3" loops the single-dismiss endpoint over every notification and reports a clean outcome', async () => {
  renderList();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss 3' }));

  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Dismissed 3'));

  expect(dismissMock).toHaveBeenCalledWith(1);
  expect(dismissMock).toHaveBeenCalledWith(2);
  expect(dismissMock).toHaveBeenCalledWith(3);
  expect(dismissMock).toHaveBeenCalledTimes(3);
});

test('a rigged failure continues the loop and reports a truthful partial outcome', async () => {
  dismissMock.mockImplementation((id: number) =>
    (id === 2 ? Promise.reject(new Error('boom')) : Promise.resolve({})));

  renderList();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss 3' }));

  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Dismissed 2 · 1 failed'));

  // Continue-on-failure: id 3 still gets attempted after id 2 rejects.
  expect(dismissMock).toHaveBeenCalledWith(3);
});

test('#239: the per-row dismiss X is disabled while the bulk dismiss loop runs', async () => {
  let resolveSecond: (v?: unknown) => void = () => {};
  dismissMock.mockImplementation((id: number) => {
    if (id === 2) return new Promise((res) => { resolveSecond = res; });
    return Promise.resolve({});
  });

  renderList();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss 3' }));
  await screen.findByText('Dismissing… 2 of 3');

  dismissMock.mockClear();
  // Racing the loop with a row's own X would double-count against the
  // loop's own outcome (a stale "succeed" on a row it's about to reach, or a
  // 404 on one it already has) — the button must be disabled, and even a
  // synthetic click through that must not call dismiss.
  const xButtons = screen.getAllByRole('button', { name: 'Dismiss notification' });
  expect(xButtons.length).toBe(3);
  xButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(xButtons[0]);
  expect(dismissMock).not.toHaveBeenCalled();

  resolveSecond();
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Dismissed 3'));

  // Loop finished — a row's own X is live again.
  const xAfter = screen.getAllByRole('button', { name: 'Dismiss notification' })[0] as HTMLButtonElement;
  expect(xAfter.disabled).toBe(false);
});

test('the dismiss button is disabled and shows progress while the loop runs, and mark-all-read stays untouched', async () => {
  let resolveSecond: (v?: unknown) => void = () => {};
  dismissMock.mockImplementation((id: number) => {
    if (id === 2) return new Promise((res) => { resolveSecond = res; });
    return Promise.resolve({});
  });

  renderList();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss 3' }));

  await screen.findByText('Dismissing… 2 of 3');
  const btn = screen.getByText('Dismissing… 2 of 3').closest('button') as HTMLButtonElement;
  expect(btn.disabled).toBe(true);

  // Mark all read is a separate mutation entirely — the dismiss loop must
  // not touch it or its own pending state.
  const markAllBtn = screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement;
  expect(markAllBtn.disabled).toBe(true); // disabled only because a bulk loop is running
  fireEvent.click(markAllBtn);
  expect(markAllReadMock).not.toHaveBeenCalled();

  resolveSecond();
  await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Dismissed 3'));
});
