// @vitest-environment jsdom
/**
 * #345 / add-person-flow (2026-09-27) — the Members section. What matters
 * here is the shape of the controls, not the network: the last owner is
 * locked in the UI (the server 409s anyway), removing confirms before firing,
 * changing someone ELSE's role applies at once while demoting YOURSELF
 * confirms, and the one "Add person" dialog branches correctly between
 * adding an existing account and falling through to an invite link.
 *
 * Also covers the 2026-09-27 code-review fixes: New link is one guarded
 * async chain (not two chained mutate() calls, which drop callbacks on a
 * double-tap), the Add person dialog can't be closed mid-request, and a few
 * a11y wires (inline error is an alert, the email helper is described-by,
 * focus moves to Copy on the invite-ready step and back to Add person on
 * close).
 */
import { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  useInvalidateMembership,
} from '@/hooks/use-members';
import { ApiError } from '@/lib/api';
import type { PropertyMember } from '@/types/inventory';

vi.mock('@/hooks/use-members', () => ({
  usePropertyMembers: vi.fn(),
  useAddMember: vi.fn(),
  useUpdateMemberRole: vi.fn(),
  useRemoveMember: vi.fn(),
  usePropertyInvites: vi.fn(),
  useCreateInvite: vi.fn(),
  useRevokeInvite: vi.fn(),
  useInvalidateMembership: vi.fn(),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { id: number; displayName: string } }) => unknown) =>
    sel({ user: { id: 42, displayName: 'Luke' } }),
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn, Toaster: () => null };
});

const add = { mutate: vi.fn(), isPending: false };
const update = { mutate: vi.fn(), isPending: false };
const remove = { mutate: vi.fn(), isPending: false };
const createInvite = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const revokeInvite = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const invalidateMembership = vi.fn();

const member = (userId: number, role: PropertyMember['role'], displayName: string): PropertyMember => ({
  id: userId, userId, role, displayName, email: `${displayName.toLowerCase()}@example.com`, avatarUrl: null,
});

function renderWith(members: PropertyMember[]) {
  vi.mocked(usePropertyMembers).mockReturnValue({ data: members, isLoading: false } as never);
  return render(<PropertyMembers propertyId={3} propertyName="The Turners" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mutate = vi.fn(); update.mutate = vi.fn(); remove.mutate = vi.fn();
  createInvite.mutate = vi.fn(); createInvite.mutateAsync = vi.fn();
  revokeInvite.mutate = vi.fn(); revokeInvite.mutateAsync = vi.fn();
  vi.mocked(useAddMember).mockReturnValue(add as never);
  vi.mocked(useUpdateMemberRole).mockReturnValue(update as never);
  vi.mocked(useRemoveMember).mockReturnValue(remove as never);
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [], isLoading: false } as never);
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
  vi.mocked(useInvalidateMembership).mockReturnValue(invalidateMembership);
});

// ── member rows (unchanged behaviour) ───────────────────────────────────────

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

// ── Add person dialog (add-person-flow spec 2026-09-27) ─────────────────────

function openAddDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
  return screen.getByRole('dialog');
}

function fillForm(dialog: HTMLElement, { name, email }: { name: string; email?: string }) {
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } });
  if (email !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: email } });
  }
}

test('email present: adds the account straight away, toasts with the response displayName, and closes', async () => {
  const { toast } = await import('@/components/ui/toast');
  add.mutate = vi.fn((_data, opts) => opts.onSuccess({ member: member(9, 'editor', 'Sam') }));
  vi.mocked(useAddMember).mockReturnValue(add as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: 'Sam', email: ' sam@example.com ' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  expect(add.mutate).toHaveBeenCalledTimes(1);
  expect(add.mutate.mock.calls[0][0]).toEqual({ email: 'sam@example.com', role: 'editor' });
  expect(toast.success).toHaveBeenCalledWith('Sam added as editor');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('email with no Tally account (404) falls through to an invite, and says so', () => {
  add.mutate = vi.fn((_data, opts) => opts.onError(new ApiError('User not found', 404)));
  vi.mocked(useAddMember).mockReturnValue(add as never);
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess({
    invite: { id: 1, propertyId: 3, role: 'editor', displayName: 'Sam', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
    url: 'https://id.example.test/join/tok1',
  }));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: 'Sam', email: 'sam@example.com' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  expect(createInvite.mutate).toHaveBeenCalledTimes(1);
  expect(createInvite.mutate.mock.calls[0][0]).toEqual({ displayName: 'Sam', role: 'editor' });
  expect(within(dialog).getByText('No Tally account uses sam@example.com, so we made an invite link instead.')).toBeTruthy();
  expect(within(dialog).getByText('https://id.example.test/join/tok1')).toBeTruthy();
});

test('ambiguous email (409, more than one account) falls through to an invite, with a note distinct from the 404 one', () => {
  add.mutate = vi.fn((_data, opts) => opts.onError(new ApiError(
    'More than one account uses that email address — ask the person to sign in once, then add them from the members list for this property',
    409,
  )));
  vi.mocked(useAddMember).mockReturnValue(add as never);
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess({
    invite: { id: 1, propertyId: 3, role: 'editor', displayName: 'Sam', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
    url: 'https://id.example.test/join/tok2',
  }));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: 'Sam', email: 'sam@example.com' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  expect(createInvite.mutate).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByText('More than one Tally account uses sam@example.com, so we made an invite link instead.')).toBeTruthy();
  expect(within(dialog).queryByText(/^No Tally account uses/)).toBeNull();
  expect(within(dialog).getByText('https://id.example.test/join/tok2')).toBeTruthy();
});

test('already-a-member 409 shows an inline, announced error and does not fall through', () => {
  add.mutate = vi.fn((_data, opts) => opts.onError(new ApiError('Already a member of this property', 409)));
  vi.mocked(useAddMember).mockReturnValue(add as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: 'Sam', email: 'sam@example.com' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  expect(createInvite.mutate).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('alert').textContent).toBe('Already a member of this property');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('no email: invites directly with the trimmed name and role', () => {
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess({
    invite: { id: 1, propertyId: 3, role: 'viewer', displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
    url: 'https://id.example.test/join/tok3',
  }));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: ' Ana ' });
  fireEvent.click(within(dialog).getByRole('radio', { name: /viewer/i }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  expect(add.mutate).not.toHaveBeenCalled();
  expect(createInvite.mutate).toHaveBeenCalledTimes(1);
  expect(createInvite.mutate.mock.calls[0][0]).toEqual({ displayName: 'Ana', role: 'viewer' });
  expect(within(dialog).queryByText(/Tally account uses/)).toBeNull();
});

test('the email field is described by its helper text', () => {
  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  const emailInput = within(dialog).getByLabelText('Email');
  const describedBy = emailInput.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toMatch(/Optional/);
});

test('the invite url is shown once and is cleared when the dialog closes and reopens; focus returns to Add person', () => {
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess({
    invite: { id: 1, propertyId: 3, role: 'editor', displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
    url: 'https://id.example.test/join/once',
  }));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const addButton = screen.getByRole('button', { name: 'Add person' });
  let dialog = openAddDialog();
  fillForm(dialog, { name: 'Ana' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));
  expect(within(dialog).getByText('https://id.example.test/join/once')).toBeTruthy();

  // Focus lands on Copy as soon as the invite-ready step appears.
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /copy link/i }));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(addButton);

  dialog = openAddDialog();
  expect(within(dialog).queryByText('https://id.example.test/join/once')).toBeNull();
  expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('');
});

test('copy link copies the url', () => {
  createInvite.mutate = vi.fn((_data, opts) => opts.onSuccess({
    invite: { id: 1, propertyId: 3, role: 'editor', displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
    url: 'https://id.example.test/join/tok4',
  }));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  renderWith([member(42, 'owner', 'Luke')]);
  const dialog = openAddDialog();
  fillForm(dialog, { name: 'Ana' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));

  fireEvent.click(within(dialog).getByRole('button', { name: /copy link/i }));
  expect(writeText).toHaveBeenCalledWith('https://id.example.test/join/tok4');
});

test('closing is blocked while a request is in flight; a late success still lands, not lost (code-review #2)', () => {
  let captured: { onSuccess: (data: unknown) => void } | null = null;
  createInvite.mutate = vi.fn((_data, opts) => { captured = opts; });
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  const { rerender } = renderWith([member(42, 'owner', 'Luke')]);
  let dialog = openAddDialog();
  fillForm(dialog, { name: 'Ana' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));
  expect(captured).not.toBeNull();

  // The request is genuinely running now (isPending flips true server-side
  // while we wait) — neither the X, Escape, nor a stray onOpenChange(false)
  // may abandon it.
  vi.mocked(useCreateInvite).mockReturnValue({ ...createInvite, isPending: true } as never);
  rerender(<PropertyMembers propertyId={3} propertyName="The Turners" />);
  dialog = screen.getByRole('dialog');

  expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();

  act(() => {
    captured!.onSuccess({
      invite: { id: 1, propertyId: 3, role: 'editor', displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' },
      url: 'https://id.example.test/join/late',
    });
  });
  expect(within(screen.getByRole('dialog')).getByText('https://id.example.test/join/late')).toBeTruthy();
});

// ── pending invite rows ──────────────────────────────────────────────────────

const PENDING = { id: 7, propertyId: 3, role: 'viewer' as const, displayName: 'Ana', invitedBy: 42, expiresAt: '2026-10-03T00:00:00Z', createdAt: '2026-09-26T00:00:00Z' };

test('pending invites render as rows in the members list, with role as text', () => {
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);

  renderWith([member(42, 'owner', 'Luke')]);
  expect(screen.getByText('Ana')).toBeTruthy();
  expect(screen.getByText(/INVITED/)).toBeTruthy();
  expect(screen.getByText('viewer')).toBeTruthy();
  // Text, not a select — no role control for a pending invite.
  expect(screen.queryByLabelText('Role for Ana')).toBeNull();
});

test('Revoke confirms before firing', () => {
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  renderWith([member(42, 'owner', 'Luke')]);

  fireEvent.click(screen.getByRole('button', { name: 'Revoke the invite to Ana' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/Revoke Ana's invite\?/)).toBeTruthy();
  expect(within(dialog).getByText(/link stops working/i)).toBeTruthy();
  expect(revokeInvite.mutate).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
  expect(revokeInvite.mutate).toHaveBeenCalledTimes(1);
  expect(revokeInvite.mutate.mock.calls[0][0]).toBe(7);
});

test('New link revokes then mints a fresh invite with the same name and role, and opens the invite-ready view', async () => {
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  revokeInvite.mutateAsync = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
  createInvite.mutateAsync = vi.fn().mockResolvedValue({
    invite: { ...PENDING, id: 9 },
    url: 'https://id.example.test/join/new',
  });
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  fireEvent.click(screen.getByRole('button', { name: 'New link' }));

  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  expect(revokeInvite.mutateAsync).toHaveBeenCalledWith(7);
  expect(createInvite.mutateAsync).toHaveBeenCalledWith({ displayName: 'Ana', role: 'viewer' });
  expect(revokeInvite.mutateAsync).toHaveBeenCalledTimes(1);
  expect(createInvite.mutateAsync).toHaveBeenCalledTimes(1);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('https://id.example.test/join/new')).toBeTruthy();
});

test('double-clicking New link fires exactly one revoke and one create (code-review #1)', async () => {
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  let resolveRevoke!: () => void;
  revokeInvite.mutateAsync = vi.fn(() => new Promise<void>((res) => { resolveRevoke = res; }));
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
  createInvite.mutateAsync = vi.fn().mockResolvedValue({
    invite: { ...PENDING, id: 9 },
    url: 'https://id.example.test/join/new',
  });
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  const newLinkButton = screen.getByRole('button', { name: 'New link' });
  fireEvent.click(newLinkButton);
  fireEvent.click(newLinkButton);
  fireEvent.click(newLinkButton);

  resolveRevoke();
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

  expect(revokeInvite.mutateAsync).toHaveBeenCalledTimes(1);
  expect(createInvite.mutateAsync).toHaveBeenCalledTimes(1);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('https://id.example.test/join/new')).toBeTruthy();
});

test('New link disables New link and Revoke on every row while it is running', async () => {
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  let resolveRevoke!: () => void;
  revokeInvite.mutateAsync = vi.fn(() => new Promise<void>((res) => { resolveRevoke = res; }));
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
  createInvite.mutateAsync = vi.fn().mockResolvedValue({ invite: { ...PENDING, id: 9 }, url: 'https://id.example.test/join/new' });
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  fireEvent.click(screen.getByRole('button', { name: 'New link' }));

  expect((screen.getByRole('button', { name: 'New link' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Revoke the invite to Ana' }) as HTMLButtonElement).disabled).toBe(true);

  resolveRevoke();
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
});

test('New link, revoke answers a 409 (already accepted OR already revoked — the server does not distinguish): toasts and refreshes instead of minting', async () => {
  const { toast } = await import('@/components/ui/toast');
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  revokeInvite.mutateAsync = vi.fn().mockRejectedValue(new ApiError('Invite already resolved', 409));
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  fireEvent.click(screen.getByRole('button', { name: 'New link' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(createInvite.mutateAsync).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("Ana's invite was already used or revoked");
  expect(invalidateMembership).toHaveBeenCalledTimes(1);
});

test('New link: the revoke succeeds but the reissue fails — the toast says the old link is dead (code-review #3)', async () => {
  const { toast } = await import('@/components/ui/toast');
  vi.mocked(usePropertyInvites).mockReturnValue({ data: [PENDING], isLoading: false } as never);
  revokeInvite.mutateAsync = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useRevokeInvite).mockReturnValue(revokeInvite as never);
  createInvite.mutateAsync = vi.fn().mockRejectedValue(new ApiError('Display name failed validation', 400));
  vi.mocked(useCreateInvite).mockReturnValue(createInvite as never);

  renderWith([member(42, 'owner', 'Luke')]);
  fireEvent.click(screen.getByRole('button', { name: 'New link' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(toast.error).toHaveBeenCalledWith(
    "Ana's old link was revoked, but a new one couldn't be made (Display name failed validation). Use Add person to invite them again.",
  );
  expect(invalidateMembership).toHaveBeenCalledTimes(1);
});
