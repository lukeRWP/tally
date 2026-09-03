// @vitest-environment jsdom
/**
 * Notification preferences (#348): only the two types the server can produce
 * get a toggle. Four more used to render — warranty expiry, item moved,
 * item removed, share expiring — with nothing behind them.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { NotificationPrefs } from './notification-prefs';

const updateMock = vi.fn();
let prefs: Record<string, boolean> | undefined;

vi.mock('@/hooks/use-notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-notifications')>();
  return {
    ...actual,
    useNotificationPreferences: () => ({ data: prefs, isLoading: false }),
    useUpdatePreference: () => ({ mutate: updateMock, isPending: false }),
  };
});

beforeEach(() => {
  updateMock.mockReset();
  prefs = { lending_due: true, custom_date: false };
});

test('renders exactly the two producible types, nothing retired', () => {
  render(<NotificationPrefs />);
  const switches = screen.getAllByRole('switch');
  expect(switches.map((s) => s.textContent)).toEqual(['Lending Due/Overdue', 'Custom Date Approaching']);
  expect(screen.queryByText(/Warranty/)).toBeNull();
  expect(screen.queryByText(/Item Moved/)).toBeNull();
  expect(screen.queryByText(/Item Removed/)).toBeNull();
  expect(screen.queryByText(/Share Link/)).toBeNull();
});

test('a toggle reflects the stored value and flips it by type', () => {
  render(<NotificationPrefs />);
  const lending = screen.getByRole('switch', { name: 'Lending Due/Overdue' });
  const custom = screen.getByRole('switch', { name: 'Custom Date Approaching' });
  expect(lending.getAttribute('aria-checked')).toBe('true');
  expect(custom.getAttribute('aria-checked')).toBe('false');

  fireEvent.click(custom);
  expect(updateMock).toHaveBeenCalledWith({ type: 'custom_date', enabled: true });
  fireEvent.click(lending);
  expect(updateMock).toHaveBeenCalledWith({ type: 'lending_due', enabled: false });
});

test('a server map that still carries a retired key does not grow the list', () => {
  prefs = { lending_due: false, custom_date: false, item_moved: true };
  render(<NotificationPrefs />);
  expect(screen.getAllByRole('switch')).toHaveLength(2);
});
