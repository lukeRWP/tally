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
  usePropertyInvites,
  useCreateInvite,
  useRevokeInvite,
} from '@/hooks/use-members';
import type { PropertyMember } from '@/types/inventory';

vi.mock('@/hooks/use-members', () => ({
  usePropertyMembers: vi.fn(),
  useAddMember: vi.fn(),
  useUpdateMemberRole: vi.fn(),
  useRemoveMember: vi.fn(),
  usePropertyInvites: vi.fn(),
  useCreateInvite: vi.fn(),
  useRevokeInvite: vi.fn(),
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
const createInvite = { mutate: vi.fn(), isPending: false };
const revokeInvite = { mutate: vi.fn(), isPending: false };

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
  createInvite.mutate = vi.fn(); revokeInvite.mutate = vi.fn();
  vi.mocked(useAddMember).mockReturnValue(add as never);
  vi.mocked(useUpdateMemberRole).mockReturnValue(update as never);
  vi.mocked(useRemoveMember).mockReturnValue(remove as never);
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [], isLoading: false } as never);
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
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

// ── invites (plan 2026-09-26-property-invites.md) ──────────────────────────

const MINTED = {
  invite: { id: 1, propertyId: 3, role: 'editor' as const, displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
  url: 'https://id.example.test/join/tok123',
};

test('the invite form sends a trimmed name and the chosen role, and is disabled while empty', () => {
  renderWith([member(42, 'owner', 'Luke')]);

  const inviteButton = screen.getByRole('button', { name: 'Invite someone new' }) as HTMLButtonElement;
  expect(inviteButton.disabled).toBe(true);

  const roleSelect = screen.getByLabelText('Role for the invite') as HTMLSelectElement;
  fireEvent.change(screen.getByLabelText('Name of the person to invite'), { target: { value: '  Ana  ' } });
  fireEvent.change(roleSelect, { target: { value: 'viewer' } });
  expect(inviteButton.disabled).toBe(false);
  fireEvent.click(inviteButton);

  expect(createInvite.mutate).toHaveBeenCalledTimes(1);
  expect(createInvite.mutate.mock.calls[0][0]).toEqual({ displayName: 'Ana', role: 'viewer' });
});

test('a minted invite opens the result dialog with the url, shown once; copy works', async () => {
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess(MINTED));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  renderWith([member(42, 'owner', 'Luke')]);
  fireEvent.change(screen.getByLabelText('Name of the person to invite'), { target: { value: 'Ana' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite someone new' }));

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(MINTED.url)).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: /copy link/i }));
  expect(writeText).toHaveBeenCalledWith(MINTED.url);
});

test('pending invites list shows each invite and revokes by id', () => {
  vi.mocked(usePropertyInvites).mockReturnValue({
    data: [{ id: 7, propertyId: 3, role: 'viewer', displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' }],
    isLoading: false,
  } as never);

  renderWith([member(42, 'owner', 'Luke')]);
  expect(screen.getByText(/Ana/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Revoke the invite to Ana' }));
  expect(revokeInvite.mutate).toHaveBeenCalledTimes(1);
  expect(revokeInvite.mutate.mock.calls[0][0]).toBe(7);
});
