import * as React from 'react';
import { Copy, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { useAddMember, useCreateInvite, type MemberRole } from '@/hooks/use-members';
import type { CreatedPropertyInvite } from '@/types/inventory';

/**
 * The "already a member" 409 is the one response this dialog must NOT treat
 * as an invitation to fall through to an invite — every other add-by-email
 * failure (no account, or more than one account on that address) falls
 * through. Matching the one case we block, rather than the many we don't, is
 * the stable half of that branch (add-person-flow spec).
 */
function isAlreadyMember(err: ApiError): boolean {
  return err.status === 409 && err.message.includes('Already a member');
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The invite-ready view — link box, copy, share. Used both by the add-person
 * dialog (after a fallthrough or a no-email invite) and by "New link" on a
 * pending row, so the two never drift apart. Focus lands on Copy on mount —
 * this view only ever appears as the RESULT of an action (never the first
 * thing open), so the next useful thing to do is always here, not back on
 * whatever was focused before.
 */
export function InviteReadyPanel({
  minted,
  note,
  myDisplayName,
  propertyName,
}: {
  minted: CreatedPropertyInvite;
  note?: string;
  myDisplayName: string;
  propertyName: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const copyRef = React.useRef<HTMLButtonElement>(null);
  const expires = formatExpiry(minted.invite.expiresAt);

  React.useEffect(() => {
    copyRef.current?.focus();
  }, []);

  function copyUrl() {
    navigator.clipboard.writeText(minted.url).then(
      () => { setCopied(true); toast.success('Link copied to clipboard'); },
      () => toast.error('Failed to copy link'),
    );
  }

  function shareUrl() {
    navigator.share?.({
      title: 'Tally invite',
      text: `${myDisplayName} invited you to "${propertyName}" on Tally. This link works once and expires ${expires}.`,
      url: minted.url,
    }).catch(() => { /* user cancelled — nothing to do */ });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Invite ready</DialogTitle>
        <DialogDescription>
          {minted.invite.displayName} isn't on Tally yet — send them this link. It works once and
          expires {expires}.
        </DialogDescription>
      </DialogHeader>
      {note && (
        <p className="text-xs text-[var(--color-text-muted)] mb-3">{note}</p>
      )}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs break-all p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] border border-[var(--color-border)]">
          {minted.url}
        </p>
        <div className="flex gap-2">
          <Button ref={copyRef} variant="outline" className="flex-1" onClick={copyUrl}>
            <Copy className="w-4 h-4" />
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {typeof navigator !== 'undefined' && !!navigator.share && (
            <Button variant="outline" className="flex-1" onClick={shareUrl}>
              <Share2 className="w-4 h-4" />
              Share
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

const EMAIL_HELP_ID = 'add-person-email-help';

/**
 * One "Add person" flow (add-person-flow spec, 2026-09-27) replaces the old
 * two unlabelled rows: an email adds an existing account straight away; no
 * email, no account, or an ambiguous email all fall through to an invite
 * link. The owner never has to know in advance which one it will be.
 */
export function AddPersonDialog({
  open,
  onOpenChange,
  propertyId,
  propertyName,
  myDisplayName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId: number;
  propertyName: string;
  myDisplayName: string;
}) {
  const addMember = useAddMember(propertyId);
  const createInvite = useCreateInvite(propertyId);

  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<Exclude<MemberRole, 'owner'>>('editor');
  const [error, setError] = React.useState<string | null>(null);
  const [minted, setMinted] = React.useState<CreatedPropertyInvite | null>(null);
  const [fallbackNote, setFallbackNote] = React.useState<string | null>(null);

  const pending = addMember.isPending || createInvite.isPending;

  function reset() {
    setName(''); setEmail(''); setRole('editor');
    setError(null); setMinted(null); setFallbackNote(null);
  }

  // A request really is in flight on pwiam/the server — closing (Escape,
  // outside click, the X, or a stray onOpenChange(false)) must not abandon
  // it: the invite gets created either way, so the one place it must land is
  // here, where the owner can still see it (code-review finding #2).
  function handleOpenChange(next: boolean) {
    if (!next) {
      if (pending) return;
      reset();
    }
    onOpenChange(next);
  }

  function preventCloseWhilePending(e: Event) {
    if (pending) e.preventDefault();
  }

  function mintInvite(displayName: string, note: string | null) {
    createInvite.mutate({ displayName, role }, {
      onSuccess: (data) => { setMinted(data); setFallbackNote(note); setError(null); },
      onError: (err: ApiError) => setError(err.message),
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      mintInvite(trimmedName, null);
      return;
    }

    addMember.mutate({ email: trimmedEmail, role }, {
      onSuccess: (data) => {
        toast.success(`${data.member.displayName} added as ${role}`);
        handleOpenChange(false);
      },
      onError: (err: ApiError) => {
        if (err.status === 404) {
          mintInvite(trimmedName, `No Tally account uses ${trimmedEmail}, so we made an invite link instead.`);
          return;
        }
        if (err.status === 409 && !isAlreadyMember(err)) {
          mintInvite(trimmedName, `More than one Tally account uses ${trimmedEmail}, so we made an invite link instead.`);
          return;
        }
        setError(err.message);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-sm"
        closeDisabled={pending}
        onEscapeKeyDown={preventCloseWhilePending}
        onPointerDownOutside={preventCloseWhilePending}
        onInteractOutside={preventCloseWhilePending}
      >
        {minted ? (
          <InviteReadyPanel minted={minted} note={fallbackNote ?? undefined} myDisplayName={myDisplayName} propertyName={propertyName} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add person</DialogTitle>
            </DialogHeader>
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-[var(--color-text)]">Name</span>
                <Input
                  aria-label="Name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  required
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-[var(--color-text)]">Email</span>
                <Input
                  aria-label="Email"
                  aria-describedby={EMAIL_HELP_ID}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  autoComplete="off"
                />
                <span id={EMAIL_HELP_ID} className="text-xs text-[var(--color-text-muted)]">
                  Optional — if they already use Tally, they're added straight away.
                </span>
              </label>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-[var(--color-text)] mb-1">Role</legend>
                <label className="flex items-start gap-2 min-h-[44px]">
                  <input
                    type="radio"
                    name="add-person-role"
                    value="editor"
                    checked={role === 'editor'}
                    onChange={() => setRole('editor')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-[var(--color-text)]">Editor</span>
                    <span className="block text-xs text-[var(--color-text-muted)]">Add, edit and move items</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 min-h-[44px]">
                  <input
                    type="radio"
                    name="add-person-role"
                    value="viewer"
                    checked={role === 'viewer'}
                    onChange={() => setRole('viewer')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-[var(--color-text)]">Viewer</span>
                    <span className="block text-xs text-[var(--color-text-muted)]">Can look, can't change anything</span>
                  </span>
                </label>
              </fieldset>

              {error && <p role="alert" className="text-sm text-[var(--color-red)]">{error}</p>}

              <Button type="submit" disabled={pending || !name.trim()} className="w-full">
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                Add person
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
