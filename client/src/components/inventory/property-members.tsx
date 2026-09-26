import * as React from 'react';
import { Copy, Loader2, Share2, UserMinus, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth-store';
import {
  usePropertyMembers,
  useAddMember,
  useUpdateMemberRole,
  useRemoveMember,
  usePropertyInvites,
  useCreateInvite,
  useRevokeInvite,
  type MemberRole,
} from '@/hooks/use-members';
import type { CreatedPropertyInvite, PropertyMember } from '@/types/inventory';

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
  const { data: invites = [] } = usePropertyInvites(propertyId);
  const addMember = useAddMember(propertyId);
  const updateRole = useUpdateMemberRole(propertyId);
  const removeMember = useRemoveMember(propertyId);
  const createInvite = useCreateInvite(propertyId);
  const revokeInvite = useRevokeInvite(propertyId);

  const [removeTarget, setRemoveTarget] = React.useState<PropertyMember | null>(null);
  // Demoting YOURSELF is the one role change that removes the control you
  // are using, so it confirms; changing someone else's role is reversible
  // from this same row and just applies.
  const [selfDemote, setSelfDemote] = React.useState<MemberRole | null>(null);
  const [email, setEmail] = React.useState('');
  const [newRole, setNewRole] = React.useState<'editor' | 'viewer'>('editor');

  // Inviting a brand-new person (plan 2026-09-26-property-invites.md), not
  // an existing tally user — a separate form from "add by email" above,
  // since there is no account to look up yet.
  const [inviteName, setInviteName] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<'editor' | 'viewer'>('editor');
  const [minted, setMinted] = React.useState<CreatedPropertyInvite | null>(null);
  const [copied, setCopied] = React.useState(false);

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

  function onInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = inviteName.trim();
    if (!trimmed) return;
    createInvite.mutate({ displayName: trimmed, role: inviteRole }, {
      onSuccess: (data) => { setMinted(data); setCopied(false); setInviteName(''); },
      onError: (err) => toast.error(err.message),
    });
  }

  function onRevokeInvite(id: number) {
    revokeInvite.mutate(id, {
      onSuccess: () => toast.success('Invite revoked'),
      onError: (err) => toast.error(err.message),
    });
  }

  function copyInviteUrl(url: string) {
    navigator.clipboard.writeText(url).then(
      () => { setCopied(true); toast.success('Link copied to clipboard'); },
      () => toast.error('Failed to copy link'),
    );
  }

  function shareInviteUrl(invite: CreatedPropertyInvite) {
    const expires = new Date(invite.invite.expiresAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
    });
    navigator.share?.({
      title: 'Tally invite',
      text: `You're invited to a property on Tally (expires ${expires}).`,
      url: invite.url,
    }).catch(() => { /* user cancelled — nothing to do */ });
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

      {/* Invite someone new — no tally account yet, so there is nothing to
          look up by email. pwiam mints the account grant; this just names
          who and what role (plan 2026-09-26-property-invites.md). */}
      <form onSubmit={onInvite} className="flex items-center gap-2 pt-2">
        <Input
          type="text"
          aria-label="Name of the person to invite"
          placeholder="Their name"
          value={inviteName}
          onChange={(e) => setInviteName(e.target.value)}
          maxLength={120}
          className="min-w-0 flex-1"
          autoComplete="off"
        />
        <Select
          aria-label="Role for the invite"
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
          className="w-28"
        >
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={createInvite.isPending || !inviteName.trim()}
        >
          {createInvite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Invite someone new'}
        </Button>
      </form>

      {invites.length > 0 && (
        <div className="pt-3">
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Pending invites</p>
          <div className="flex flex-col gap-2">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] border border-[var(--color-border)]"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--color-text)] truncate">
                    {invite.displayName} <span className="text-[var(--color-text-muted)]">· {invite.role}</span>
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    Expires {new Date(invite.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRevokeInvite(invite.id)}
                  disabled={revokeInvite.isPending}
                  className="shrink-0 text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
                  aria-label={`Revoke the invite to ${invite.displayName}`}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The new invite's join link — its only appearance. pwiam never gives
          it back, and tally never stores it (plan "url returned once"). */}
      <Dialog open={!!minted} onOpenChange={(open) => { if (!open) setMinted(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Invite ready</DialogTitle>
            <DialogDescription>
              Send this link to {minted?.invite.displayName}. It expires{' '}
              {minted && new Date(minted.invite.expiresAt).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric',
              })}
              , and only works once.
            </DialogDescription>
          </DialogHeader>
          {minted && (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-xs break-all p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] border border-[var(--color-border)]">
                {minted.url}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => copyInviteUrl(minted.url)}>
                  <Copy className="w-4 h-4" />
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                {typeof navigator !== 'undefined' && !!navigator.share && (
                  <Button variant="outline" className="flex-1" onClick={() => shareInviteUrl(minted)}>
                    <Share2 className="w-4 h-4" />
                    Share
                  </Button>
                )}
              </div>
            </div>
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
    </div>
  );
}
