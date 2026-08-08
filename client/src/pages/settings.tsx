import * as React from 'react';
import { LogOut, Sun, Moon, Monitor, Trash2, Copy } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { RuledRow } from '@/components/ui/ruled-row';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/store/auth-store';
import { useProperties } from '@/hooks/use-inventory';
import { PropertyChips } from '@/components/inventory/property-chips';
import { TagManager } from '@/components/tags/tag-manager';
import { NotificationPrefs } from '@/components/notifications/notification-prefs';
import { PrinterSettings } from '@/components/print/printer-settings';
import { useMyShareLinks, useRevokeShareLink } from '@/hooks/use-sharing';
import { toast } from '@/components/ui/toast';

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// -- Share Links Section --------------------------------------------------------

function ShareLinksSection() {
  const { data: allLinks = [], isLoading } = useMyShareLinks();
  const revokeLink = useRevokeShareLink();

  function handleCopy(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.error('Failed to copy'),
    );
  }

  function handleRevoke(id: number) {
    revokeLink.mutate(id, {
      onSuccess: () => toast.success('Link revoked'),
      onError: (err) => toast.error(err.message),
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
            <span className="block truncate font-mono text-[11px] text-[var(--color-text-muted)]">{link.url}</span>
            <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Expires {formatDate(link.expiresAt)}
            </span>
          </span>
          {/* Named, not titled — a tooltip never appears on touch, so on a phone
              these two icons would be the same unlabelled square. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Copy the ${link.entityType} share link`}
            onClick={() => handleCopy(link.url)}
          >
            <Copy className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Revoke the ${link.entityType} share link`}
            disabled={revokeLink.isPending}
            onClick={() => handleRevoke(link.id)}
            className="text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      ))}
    </section>
  );
}

// -- Settings Page Main ---------------------------------------------------------

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, theme, setTheme, logout } = useAuthStore();
  const { data: properties = [] } = useProperties();

  const [selectedPropertyId, setSelectedPropertyId] = React.useState<number>(0);

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

      {/* Desktop: 2-column layout / Mobile: single column */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-8">
        {/* Left column */}
        <div className="flex flex-col gap-5">
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
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-5 mt-5 lg:mt-0">
          {/* Tags */}
          {properties.length > 0 && (
            <section className="flex flex-col gap-2 animate-fade-up" style={{ animationDelay: '40ms' }}>
              <ColHead>Tags</ColHead>
              {selectedPropertyId > 0 && <TagManager propertyId={selectedPropertyId} />}
            </section>
          )}

          {/* Notifications */}
          <section className="flex flex-col animate-fade-up" style={{ animationDelay: '80ms' }}>
            <ColHead>Notifications</ColHead>
            <NotificationPrefs />
          </section>

          {/* Printing -- printer registration, loaded roll, job queue */}
          {selectedPropertyId > 0 && (
            <section className="flex flex-col gap-3 animate-fade-up" style={{ animationDelay: '120ms' }}>
              <ColHead>Printing</ColHead>
              <PrinterSettings propertyId={selectedPropertyId} />
            </section>
          )}

          <ShareLinksSection />
        </div>
      </div>

      {/* Logout -- full width below */}
      <div className="border-t border-[var(--color-rule)]" />
      <Button variant="destructive" onClick={logout} className="w-full lg:max-w-xs animate-fade-up" style={{ animationDelay: '200ms' }}>
        <LogOut className="w-4 h-4" />
        Sign Out
      </Button>
    </div>
  );
}
