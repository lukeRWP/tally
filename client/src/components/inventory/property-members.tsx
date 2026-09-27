import * as React from 'react';
import { UserMinus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth-store';
import { ApiError } from '@/lib/api';
import { AddPersonDialog, InviteReadyPanel } from './add-person-dialog';
import {
  usePropertyMembers,
  useUpdateMemberRole,
  useRemoveMember,
  usePropertyInvites,
  useCreateInvite,
  useRevokeInvite,
  useInvalidateMembership,
  type MemberRole,
} from '@/hooks/use-members';
import type { CreatedPropertyInvite, PropertyInvite, PropertyMember } from '@/types/inventory';

const ROLES: { value: MemberRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

/**
 * Who can see and change this property (#345). Owner-only: the page only
 * mounts this when the selected property's role is owner, and every route
 * behind it is `requireRole('owner')` regardless.
 *
 * The one rule with teeth is "a property always has an owner". The server
 * enforces it (409) inside a row lock; here it is reflected as a disabled
 * control on the only owner, because a select that lets you pick something
 * and then refuses is worse than one that tells you up front.
 *
 * One "Add person" flow (add-person-flow spec, 2026-09-27) replaced the old
 * two unlabelled rows, and pending invites now render as rows in this same
 * list instead of a separate card — see `add-person-dialog.tsx`.
 */
export function PropertyMembers({ propertyId, propertyName }: { propertyId: number; propertyName: string }) {
  const me = useAuthStore((s) => s.user);
  const { data: members = [], isLoading } = usePropertyMembers(propertyId);
  const { data: invites = [] } = usePropertyInvites(propertyId);
  const updateRole = useUpdateMemberRole(propertyId);
  const removeMember = useRemoveMember(propertyId);
  const createInvite = useCreateInvite(propertyId);
  const revokeInvite = useRevokeInvite(propertyId);
  const invalidateMembership = useInvalidateMembership(propertyId);

  const [removeTarget, setRemoveTarget] = React.useState<PropertyMember | null>(null);
  // Demoting YOURSELF is the one role change that removes the control you
  // are using, so it confirms; changing someone else's role is reversible
  // from this same row and just applies.
  const [selfDemote, setSelfDemote] = React.useState<MemberRole | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<PropertyInvite | null>(null);
  const [relinked, setRelinked] = React.useState<CreatedPropertyInvite | null>(null);

  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const isLastOwner = (m: PropertyMember) => m.role === 'owner' && ownerCount <= 1;
  const busy = updateRole.isPending || removeMember.isPending;

  function applyRole(member: PropertyMember, role: MemberRole) {
    updateRole.mutate({ userId: member.userId, role }, {
      onSuccess: () => toast.success(`${member.displayName} is now ${role}`),
      onError: (err) => toast.error(err.message),
    });
  }

  function onRoleChange(member: PropertyMember, role: MemberRole) {
    if (role === member.role) return;
    if (member.userId === me?.id && member.role === 'owner') {
      setSelfDemote(role);
      return;
    }
    applyRole(member, role);
  }

  function confirmRemove() {
    if (!removeTarget) return;
    const target = removeTarget;
    removeMember.mutate(target.userId, {
      onSuccess: () => { toast.success(`${target.displayName} removed`); setRemoveTarget(null); },
      onError: (err) => { toast.error(err.message); setRemoveTarget(null); },
    });
  }

  function confirmSelfDemote() {
    const mine = members.find((m) => m.userId === me?.id);
    if (!mine || !selfDemote) return;
    applyRole(mine, selfDemote);
    setSelfDemote(null);
  }

  // "New link": revoke the pending invite, then mint a fresh one with the
  // same name and role — the owner never re-types either.
  function onNewLink(invite: PropertyInvite) {
    revokeInvite.mutate(invite.id, {
      onSuccess: () => {
        createInvite.mutate({ displayName: invite.displayName, role: invite.role }, {
          onSuccess: (data) => setRelinked(data),
          onError: (err: ApiError) => toast.error(err.message),
        });
      },
      onError: (err: ApiError) => {
        // The invitee accepted between our list render and this click —
        // there is no invite left to relink, only a member to refresh in.
        if (err.status === 409 && err.message.includes('accepted')) {
          toast.success(`${invite.displayName} already accepted — they're a member now`);
        } else {
          toast.error(err.message);
        }
        invalidateMembership();
      },
    });
  }

  function confirmRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    revokeInvite.mutate(target.id, {
      onSuccess: () => { toast.success('Invite revoked'); setRevokeTarget(null); },
      onError: (err) => { toast.error(err.message); setRevokeTarget(null); },
    });
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end pb-2">
        <Button onClick={() => setAddOpen(true)}>
          <UserPlus className="w-4 h-4" />
          Add person
        </Button>
      </div>

      {isLoading && <Skeleton className="h-14 w-full mt-2" />}

      {members.map((member) => {
        const isMe = member.userId === me?.id;
        const locked = isLastOwner(member);
        const name = isMe ? `${member.displayName} (you)` : member.displayName;
        return (
          <div
            key={member.userId}
            className="flex items-center gap-2 min-h-[44px] py-2 border-b border-[var(--color-rule)] last:border-b-0"
          >
            {member.avatarUrl ? (
              <img src={member.avatarUrl} alt="" className="w-8 h-8 shrink-0 rounded-[var(--radius-sm)] object-cover border border-[var(--color-rule)]" />
            ) : (
              <span aria-hidden className="w-8 h-8 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-text)] flex items-center justify-center font-mono text-xs font-bold text-[var(--color-text)]">
                {member.displayName.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{name}</span>
              <span className="block truncate font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {locked ? 'only owner' : member.email}
              </span>
            </span>
            <Select
              aria-label={`Role for ${member.displayName}`}
              value={member.role}
              disabled={locked || busy}
              onChange={(e) => onRoleChange(member, e.target.value as MemberRole)}
              className="w-28 min-h-0 py-1.5"
            >
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${member.displayName}`}
              disabled={locked || busy}
              onClick={() => setRemoveTarget(member)}
              className="text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
            >
              <UserMinus className="w-4 h-4" />
            </Button>
          </div>
        );
      })}

      {invites.map((invite) => (
        <div
          key={invite.id}
          className="flex items-center gap-2 min-h-[44px] py-2 border-b border-[var(--color-rule)] last:border-b-0"
        >
          <span aria-hidden className="w-8 h-8 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-text)] flex items-center justify-center font-mono text-xs font-bold text-[var(--color-text)]">
            {invite.displayName.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{invite.displayName}</span>
            <span className="block truncate font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              INVITED &middot; EXPIRES {formatExpiry(invite.expiresAt)}
            </span>
          </span>
          <span className="w-28 shrink-0 text-sm text-[var(--color-text-muted)] capitalize">{invite.role}</span>
          <Button variant="ghost" size="sm" onClick={() => onNewLink(invite)}>
            New link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRevokeTarget(invite)}
            className="text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
            aria-label={`Revoke the invite to ${invite.displayName}`}
          >
            Revoke
          </Button>
        </div>
      ))}

      <AddPersonDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        propertyId={propertyId}
        propertyName={propertyName}
        myDisplayName={me?.displayName ?? ''}
      />

      {/* "New link"'s result — same invite-ready view as the add-person
          dialog, opened directly since there is nothing left to fill in. */}
      <Dialog open={!!relinked} onOpenChange={(open) => { if (!open) setRelinked(null); }}>
        <DialogContent className="max-w-sm">
          {relinked && (
            <InviteReadyPanel minted={relinked} myDisplayName={me?.displayName ?? ''} propertyName={propertyName} />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open && !removeMember.isPending) setRemoveTarget(null); }}
        title={`Remove ${removeTarget?.displayName ?? ''}?`}
        description={
          removeTarget?.userId === me?.id
            ? "You'll lose access to this property immediately. Another owner would have to add you back."
            : 'They lose access to this property immediately. You can add them again later.'
        }
        destructive
        confirmLabel="Remove"
        isPending={removeMember.isPending}
        onConfirm={confirmRemove}
      />

      <ConfirmDialog
        open={!!selfDemote}
        onOpenChange={(open) => { if (!open && !updateRole.isPending) setSelfDemote(null); }}
        title={`Make yourself ${selfDemote ?? ''}?`}
        description="You'll lose the owner controls on this property, including this members list. Another owner would have to promote you back."
        destructive
        confirmLabel="Change my role"
        isPending={updateRole.isPending}
        onConfirm={confirmSelfDemote}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open && !revokeInvite.isPending) setRevokeTarget(null); }}
        title={`Revoke ${revokeTarget?.displayName ?? ''}'s invite?`}
        description="The link stops working."
        destructive
        confirmLabel="Revoke"
        isPending={revokeInvite.isPending}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}
