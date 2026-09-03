import * as React from 'react';
import { LogOut, Sun, Moon, Monitor, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { RuledRow } from '@/components/ui/ruled-row';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuthStore } from '@/store/auth-store';
import { useProperties } from '@/hooks/use-inventory';
import { PropertyChips } from '@/components/inventory/property-chips';
import { PropertyMembers } from '@/components/inventory/property-members';
import { TagManager } from '@/components/tags/tag-manager';
import { NotificationPrefs } from '@/components/notifications/notification-prefs';
import { PrinterSettings } from '@/components/print/printer-settings';
import { useMyShareLinks, useRevokeShareLink } from '@/hooks/use-sharing';
import { toast } from '@/components/ui/toast';
import { useVisionPref } from '@/store/vision-store';

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// -- Share Links Section --------------------------------------------------------

export function ShareLinksSection() {
  const { data: allLinks = [], isLoading } = useMyShareLinks();
  const revokeLink = useRevokeShareLink();
  // An owner's list carries links other members made on their property
  // (#349); "by Sam" is the only way to tell those from your own.
  const myId = useAuthStore().user?.id ?? null;
  // The link is gone the instant this fires — no undo, and the same token
  // can't be reissued (a new share creates a new token). That's the one
  // irreversible action on this page that had no confirm at all (#278).
  const [revokeTarget, setRevokeTarget] = React.useState<{ id: number; entityType: string } | null>(null);

  function confirmRevoke() {
    if (!revokeTarget) return;
    const { id } = revokeTarget;
    revokeLink.mutate(id, {
      onSuccess: () => { toast.success('Link revoked'); setRevokeTarget(null); },
      onError: (err) => { toast.error(err.message); setRevokeTarget(null); },
    });
  }

  return (
    <section className="flex flex-col animate-fade-up" style={{ animationDelay: '160ms' }}>
      <ColHead>Share links · {allLinks.length}</ColHead>

      {isLoading && <Skeleton className="h-14 w-full mt-2" />}

      {!isLoading && allLinks.length === 0 && (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
          No active share links
        </p>
      )}

      {allLinks.map((link) => (
        <div
          key={link.id}
          className="flex items-center gap-2 min-h-[44px] py-2 border-b border-[var(--color-rule)] last:border-b-0"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold capitalize text-[var(--color-text)]">{link.entityType}</span>
            {/* No URL and no copy (#349): the server holds only a digest of
                the token, so the address exists exactly once — in the dialog
                that made it. What this row can honestly say is when it was
                made, by whom, and when it stops working. */}
            <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Created {formatDate(link.createdAt)}
              {link.createdBy !== myId && link.createdByName ? ` by ${link.createdByName}` : ''}
              {' · '}Expires {formatDate(link.expiresAt)}
            </span>
          </span>
          {/* Named, not titled — a tooltip never appears on touch, so on a phone
              the icon would be an unlabelled square. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Revoke the ${link.entityType} share link`}
            disabled={revokeLink.isPending}
            onClick={() => setRevokeTarget({ id: link.id, entityType: link.entityType })}
            className="text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      ))}

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open && !revokeLink.isPending) setRevokeTarget(null); }}
        title={`Revoke this ${revokeTarget?.entityType ?? ''} link?`}
        description="Anyone holding it loses access immediately. This can't be undone — the same link can't be reissued, only replaced with a new one."
        destructive
        confirmLabel="Revoke"
        isPending={revokeLink.isPending}
        onConfirm={confirmRevoke}
      />
    </section>
  );
}

// -- Settings Page Main ---------------------------------------------------------

/**
 * The user-facing off switch for photo identification.
 *
 * Deliberately says what it costs. "AI features" as a bare toggle tells someone
 * nothing about why they might want it off; the reason is money and it is a
 * small enough number to just print.
 */
function PhotoIdentificationSection() {
  const enabled = useVisionPref((p) => p.enabled);
  const setEnabled = useVisionPref((p) => p.setEnabled);

  return (
    <section className="flex flex-col animate-fade-up" style={{ animationDelay: '160ms' }}>
      <ColHead>Photo identification</ColHead>
      <div className="flex items-center gap-3 min-h-[44px] py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--color-text)]">
            Suggest a name from the photo
          </span>
          <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            {enabled
              ? 'about half a cent per photo — off means no request is made'
              : 'off — photos still save with the item'}
          </span>
        </span>
        <Button
          size="sm"
          variant={enabled ? 'default' : 'outline'}
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
        >
          {enabled ? 'On' : 'Off'}
        </Button>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, theme, setTheme, logout } = useAuthStore();
  const { data: properties = [] } = useProperties();

  const [selectedPropertyId, setSelectedPropertyId] = React.useState<number>(0);
  const selectedRole = properties.find((p) => p.id === selectedPropertyId)?.role ?? null;

  // Auto-select first property
  React.useEffect(() => {
    if (!selectedPropertyId && properties.length > 0) {
      setSelectedPropertyId(properties[0].id);
    }
  }, [properties, selectedPropertyId]);

  const themeOptions = [
    { key: 'light' as const, icon: Sun, label: 'Light' },
    { key: 'dark' as const, icon: Moon, label: 'Dark' },
    { key: 'system' as const, icon: Monitor, label: 'System' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <h1 className="animate-fade-up"><TitleBar>Settings</TitleBar></h1>

      {/* Tags and printers are both property-scoped, so the selector belongs to
          the page: parked inside either section it silently governs the other. */}
      <PropertyChips
        properties={properties}
        value={selectedPropertyId}
        onChange={setSelectedPropertyId}
      />

      {/* Desktop: 2-column layout / Mobile: single column.
          The split is ASSIGNED, not computed, so it is only as good as what is
          on each side. It used to put three short sections on the left and
          five long ones on the right: at 1440×900 the left column's last
          content ended at y≈352 while the right ran to y≈1260, so half the
          screen sat blank while the page still scrolled (#283).

          The rule it follows now is not "shortest first" — that would need
          re-deciding every time a section changed. FIXED-HEIGHT sections go
          left (profile, theme, recycle bin, the six notification switches, the
          photo-identify switch) and the ones that GROW WITH THE PROPERTY go
          right (tags, printers, share links, members). The balance then cannot be
          undone by a house that happens to have thirty tags. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-8">
        {/* Left column. Tagged because WHICH column a section sits in is the
            whole of the balance fix, and jsdom does no layout — the same
            device reports.tsx's row stacks use (#275). */}
        <div data-settings-column="left" className="flex flex-col gap-5">
          {/* Profile */}
          <section className="flex flex-col animate-fade-up">
            <ColHead>Profile</ColHead>
            {user ? (
              <div className="flex items-center gap-3 py-3">
                {user.avatarUrl ? (
                  // alt="" — the display name is already read out alongside it.
                  <img
                    src={user.avatarUrl}
                    alt=""
                    className="w-10 h-10 rounded-[var(--radius-sm)] object-cover border border-[var(--color-rule)]"
                  />
                ) : (
                  <span className="w-10 h-10 rounded-[var(--radius-sm)] border border-[var(--color-text)] flex items-center justify-center font-mono text-sm font-bold text-[var(--color-text)]">
                    {user.displayName.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{user.displayName}</span>
                  <span className="block truncate font-mono text-[11px] text-[var(--color-text-muted)]">{user.email}</span>
                </span>
              </div>
            ) : (
              <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
                Not signed in
              </p>
            )}
          </section>

          {/* Appearance — a setting, not a filter, so it commits with squared
              buttons rather than pills. */}
          <section className="flex flex-col gap-2 animate-fade-up" style={{ animationDelay: '40ms' }}>
            <ColHead>Appearance</ColHead>
            <div className="flex gap-2 pt-1">
              {themeOptions.map(({ key, icon: Icon, label }) => (
                <Button
                  key={key}
                  size="sm"
                  variant={theme === key ? 'default' : 'outline'}
                  aria-pressed={theme === key}
                  onClick={() => setTheme(key)}
                  className="flex-1"
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Button>
              ))}
            </div>
          </section>

          {/* Every delete in the app funnels into the recycle bin, and this is
              its only entry point, so it sits on the page rather than behind a
              disclosure. */}
          <section className="flex flex-col animate-fade-up" style={{ animationDelay: '80ms' }}>
            <ColHead>Data</ColHead>
            <RuledRow
              onNavigate={() => navigate('/recycle-bin')}
              leading={<Trash2 className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />}
              title="Recycle bin"
              meta="Deleted things, restorable for 30 days"
            />
          </section>

          {/* Notifications — a per-user preference like Appearance above it,
              rather than property data like Tags and Printing opposite. */}
          <section className="flex flex-col animate-fade-up" style={{ animationDelay: '120ms' }}>
            <ColHead>Notifications</ColHead>
            <NotificationPrefs />
          </section>

          {/* Photo identification -- the user-facing off switch. Not gated on a
              property: it is a per-device preference, not property data, which
              is also why it belongs on this side of the fold. */}
          <PhotoIdentificationSection />
        </div>

        {/* Right column */}
        <div data-settings-column="right" className="flex flex-col gap-5 mt-5 lg:mt-0">
          {/* Tags */}
          {properties.length > 0 && (
            <section className="flex flex-col gap-2 animate-fade-up" style={{ animationDelay: '40ms' }}>
              <ColHead>Tags</ColHead>
              {selectedPropertyId > 0 && <TagManager propertyId={selectedPropertyId} />}
            </section>
          )}

          {/* Printing -- printer registration, loaded roll, job queue */}
          {selectedPropertyId > 0 && (
            <section className="flex flex-col gap-3 animate-fade-up" style={{ animationDelay: '120ms' }}>
              <ColHead>Printing</ColHead>
              <PrinterSettings propertyId={selectedPropertyId} />
            </section>
          )}

          <ShareLinksSection />

          {/* Members -- who can see this property. Owner-only, and gated on
              the CALLER's role in the selected property (the list carries it),
              so an editor never mounts a section whose every call would 403
              (#345). Grows with the household, so it sits on this side. */}
          {selectedRole === 'owner' && (
            <section className="flex flex-col animate-fade-up" style={{ animationDelay: '200ms' }}>
              <ColHead>Members</ColHead>
              <PropertyMembers propertyId={selectedPropertyId} />
            </section>
          )}
        </div>
      </div>

      {/* Logout -- full width below. Signing out destroys nothing, so it does
          not get the destructive treatment (#278) — that's reserved for the
          share-link/printer/tag controls above, which are actually
          irreversible and now confirm before acting. */}
      <div className="border-t border-[var(--color-rule)]" />
      <Button variant="outline" onClick={logout} className="w-full lg:max-w-xs animate-fade-up" style={{ animationDelay: '200ms' }}>
        <LogOut className="w-4 h-4" />
        Sign Out
      </Button>
    </div>
  );
}
