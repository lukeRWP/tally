// @vitest-environment jsdom
/**
 * #345 — the Members section. What matters here is the shape of the
 * controls, not the network: the last owner is locked in the UI (the server
 * 409s anyway), removing confirms before firing, changing someone ELSE's role
 * applies at once while demoting YOURSELF confirms, and the add form sends
 * exactly what the route validates.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { PropertyMembers } from './property-members';
import {
  usePropertyMembers,
  useAddMember,
  useUpdateMemberRole,
  useRemoveMember,
} from '@/hooks/use-members';
import type { PropertyMember } from '@/types/inventory';

vi.mock('@/hooks/use-members', () => ({
  usePropertyMembers: vi.fn(),
  useAddMember: vi.fn(),
  useUpdateMemberRole: vi.fn(),
  useRemoveMember: vi.fn(),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { id: number } }) => unknown) => sel({ user: { id: 42 } }),
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const add = { mutate: vi.fn(), isPending: false };
const update = { mutate: vi.fn(), isPending: false };
const remove = { mutate: vi.fn(), isPending: false };

const member = (userId: number, role: PropertyMember['role'], displayName: string): PropertyMember => ({
  id: userId, userId, role, displayName, email: `${displayName.toLowerCase()}@example.com`, avatarUrl: null,
});

function renderWith(members: PropertyMember[]) {
  vi.mocked(usePropertyMembers).mockReturnValue({ data: members, isLoading: false } as never);
  return render(<PropertyMembers propertyId={3} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mutate = vi.fn(); update.mutate = vi.fn(); remove.mutate = vi.fn();
  vi.mocked(useAddMember).mockReturnValue(add as never);
  vi.mocked(useUpdateMemberRole).mockReturnValue(update as never);
  vi.mocked(useRemoveMember).mockReturnValue(remove as never);
});

test('the only owner is locked: role select and remove are disabled and the row says so', () => {
  renderWith([member(42, 'owner', 'Luke'), member(8, 'editor', 'Sam')]);

  expect(screen.getByText('Luke (you)')).toBeTruthy();
  expect(screen.getByText('only owner')).toBeTruthy();
  expect((screen.getByLabelText('Role for Luke') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Remove Luke' }) as HTMLButtonElement).disabled).toBe(true);

  // The editor is fully editable.
  expect((screen.getByLabelText('Role for Sam') as HTMLSelectElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Remove Sam' }) as HTMLButtonElement).disabled).toBe(false);
});

test('with two owners neither is locked', () => {
  renderWith([member(42, 'owner', 'Luke'), member(7, 'owner', 'Ana')]);
  expect(screen.queryByText('only owner')).toBeNull();
  expect((screen.getByLabelText('Role for Luke') as HTMLSelectElement).disabled).toBe(false);
  expect((screen.getByLabelText('Role for Ana') as HTMLSelectElement).disabled).toBe(false);
});

test("changing someone else's role applies immediately with the userId and role", () => {
  renderWith([member(42, 'owner', 'Luke'), member(8, 'editor', 'Sam')]);

  fireEvent.change(screen.getByLabelText('Role for Sam'), { target: { value: 'viewer' } });

  expect(update.mutate).toHaveBeenCalledTimes(1);
  expect(update.mutate.mock.calls[0][0]).toEqual({ userId: 8, role: 'viewer' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('demoting yourself confirms first, and only fires on confirm', () => {
  renderWith([member(42, 'owner', 'Luke'), member(7, 'owner', 'Ana')]);

  fireEvent.change(screen.getByLabelText('Role for Luke'), { target: { value: 'editor' } });
  expect(update.mutate).not.toHaveBeenCalled();

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Make yourself editor?')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Change my role' }));

  expect(update.mutate).toHaveBeenCalledTimes(1);
  expect(update.mutate.mock.calls[0][0]).toEqual({ userId: 42, role: 'editor' });
});

test('removing a member confirms first; cancel is a no-op, confirm sends the userId', () => {
  renderWith([member(42, 'owner', 'Luke'), member(8, 'editor', 'Sam')]);

  fireEvent.click(screen.getByRole('button', { name: 'Remove Sam' }));
  let dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Remove Sam?')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remove.mutate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Remove Sam' }));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(remove.mutate).toHaveBeenCalledTimes(1);
  expect(remove.mutate.mock.calls[0][0]).toBe(8);
});

test('removing yourself says so in the confirm', () => {
  renderWith([member(42, 'owner', 'Luke'), member(7, 'owner', 'Ana')]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Luke' }));
  expect(within(screen.getByRole('dialog')).getByText(/you'll lose access/i)).toBeTruthy();
});

test('the add form sends a trimmed email and the chosen non-owner role, and is disabled while empty', () => {
  renderWith([member(42, 'owner', 'Luke')]);

  const addButton = screen.getByRole('button', { name: 'Add member' }) as HTMLButtonElement;
  expect(addButton.disabled).toBe(true);

  const roleSelect = screen.getByLabelText('Role for the new member') as HTMLSelectElement;
  expect(Array.from(roleSelect.options).map((o) => o.value)).toEqual(['editor', 'viewer']);

  fireEvent.change(screen.getByLabelText('Email address to add'), { target: { value: '  sam@example.com ' } });
  fireEvent.change(roleSelect, { target: { value: 'viewer' } });
  expect(addButton.disabled).toBe(false);
  fireEvent.click(addButton);

  expect(add.mutate).toHaveBeenCalledTimes(1);
  expect(add.mutate.mock.calls[0][0]).toEqual({ email: 'sam@example.com', role: 'viewer' });
});
