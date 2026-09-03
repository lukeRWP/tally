// @vitest-environment jsdom
/**
 * #345 — the Members section is gated on the CALLER's role in the selected
 * property, which the properties list already carries. An editor must never
 * see a section whose every request would 403.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { SettingsPage } from './settings';
import { useProperties } from '@/hooks/use-inventory';

vi.mock('@/components/notifications/notification-prefs', () => ({ NotificationPrefs: () => null }));
vi.mock('@/components/print/printer-settings', () => ({ PrinterSettings: () => null }));
vi.mock('@/components/tags/tag-manager', () => ({ TagManager: () => null }));
vi.mock('@/components/inventory/property-members', () => ({
  PropertyMembers: ({ propertyId }: { propertyId: number }) => <div data-testid="members" data-property={propertyId} />,
}));
vi.mock('@/hooks/use-inventory', () => ({ useProperties: vi.fn() }));
vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: () => ({ data: [], isLoading: false }),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({
    user: { displayName: 'Luke', email: 'luke@example.com', avatarUrl: null },
    theme: 'system', setTheme: vi.fn(), logout: vi.fn(),
  }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }), Toaster: () => null }));

const property = (id: number, role: 'owner' | 'editor' | 'viewer') => ({
  id, name: `Prop ${id}`, address: null, description: null, qrCode: 'q', role,
  areaCount: 0, containerCount: 0, itemCount: 0, createdAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => vi.clearAllMocks());

test('an owner of the selected property sees Members, scoped to that property', () => {
  vi.mocked(useProperties).mockReturnValue({ data: [property(3, 'owner')] } as never);
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  expect(screen.getByText('Members')).toBeTruthy();
  expect(screen.getByTestId('members').getAttribute('data-property')).toBe('3');
});

test('an editor of the selected property does not get a Members section at all', () => {
  vi.mocked(useProperties).mockReturnValue({ data: [property(3, 'editor')] } as never);
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  expect(screen.queryByText('Members')).toBeNull();
  expect(screen.queryByTestId('members')).toBeNull();
});
