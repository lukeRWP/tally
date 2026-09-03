import * as React from 'react';
import { UserMinus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth-store';
import {
  usePropertyMembers,
  useAddMember,
  useUpdateMemberRole,
  useRemoveMember,
  type MemberRole,
} from '@/hooks/use-members';
import type { PropertyMember } from '@/types/inventory';

const ROLES: { value: MemberRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];

/**
 * Who can see and change this property (#345). Owner-only: the page only
 * mounts this when the selected property's role is owner, and every route
 * behind it is `requireRole('owner')` regardless.
 *
 * The one rule with teeth is "a property always has an owner". The server
 * enforces it (409) inside a row lock; here it is reflected as a disabled
 * control on the only owner, because a select that lets you pick something
 * and then refuses is worse than one that tells you up front.
 */
export function PropertyMembers({ propertyId }: { propertyId: number }) {
  const me = useAuthStore((s) => s.user);
  const { data: members = [], isLoading } = usePropertyMembers(propertyId);
  const addMember = useAddMember(propertyId);
  const updateRole = useUpdateMemberRole(propertyId);
  const removeMember = useRemoveMember(propertyId);

  const [removeTarget, setRemoveTarget] = React.useState<PropertyMember | null>(null);
  // Demoting YOURSELF is the one role change that removes the control you
  // are using, so it confirms; changing someone else's role is reversible
  // from this same row and just applies.
  const [selfDemote, setSelfDemote] = React.useState<MemberRole | null>(null);
  const [email, setEmail] = React.useState('');
  const [newRole, setNewRole] = React.useState<'editor' | 'viewer'>('editor');

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

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    addMember.mutate({ email: trimmed, role: newRole }, {
      onSuccess: (data) => { toast.success(`${data.member.displayName} added as ${newRole}`); setEmail(''); },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <div className="flex flex-col">
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

      {/* Add by email. Owner is deliberately not offered here: promote after
          adding, from the row, so a typo in the address never mints an owner. */}
      <form onSubmit={onAdd} className="flex items-center gap-2 pt-3">
        <Input
          type="email"
          aria-label="Email address to add"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-0 flex-1"
          autoComplete="off"
        />
        <Select
          aria-label="Role for the new member"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as 'editor' | 'viewer')}
          className="w-28"
        >
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Button type="submit" size="icon" aria-label="Add member" disabled={addMember.isPending || !email.trim()}>
          <UserPlus className="w-4 h-4" />
        </Button>
      </form>

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
    </div>
  );
}
