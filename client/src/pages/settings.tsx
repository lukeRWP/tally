import * as React from 'react';
import { LogOut, Sun, Moon, Monitor, Trash2, Link2, Copy, Tags, ChevronRight, ChevronDown, BarChart2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TitleBar } from '@/components/ui/title-bar';
import { useAuthStore } from '@/store/auth-store';
import { useProperties } from '@/hooks/use-inventory';
import { TagManager } from '@/components/tags/tag-manager';
import { NotificationPrefsRedesigned } from '@/components/notifications/notification-prefs-redesigned';
import { PrinterSettings } from '@/components/print/printer-settings';
import { useMyShareLinks, useRevokeShareLink } from '@/hooks/use-sharing';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// -- Collapsible Settings Section -----------------------------------------------

function CollapsibleSettingsSection({
  title,
  defaultOpen = true,
  children,
  animationDelay,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  animationDelay?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <Card animationDelay={animationDelay}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center w-full gap-2 text-left cursor-pointer"
      >
        <h2 className="text-sm font-semibold text-[var(--color-text)] flex-1">{title}</h2>
        {open ? (
          <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)]" />
        )}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </Card>
  );
}

// -- Share Links Section --------------------------------------------------------

function ShareLinksSection() {
  const { data: links, isLoading } = useMyShareLinks();
  const revokeLink = useRevokeShareLink();

  const allLinks = (links as unknown as {
    id: number; token: string; entityType: string; entityId: number;
    url: string; expiresAt: string; createdAt: string;
  }[] | undefined) ?? [];

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
    <Card animationDelay="300ms">
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-[var(--color-primary)]" />
        Share Links
      </h2>

      {isLoading && (
        <p className="text-xs text-[var(--color-text-muted)]">Loading...</p>
      )}

      {!isLoading && allLinks.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">No active share links.</p>
      )}

      {!isLoading && allLinks.length > 0 && (
        <div className="flex flex-col gap-2">
          {allLinks.map((link) => (
            <div
              key={link.id}
              className="flex items-start gap-2 p-2.5 rounded-[var(--radius-md)] bg-[var(--color-elevated)] transition-all duration-150"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--color-text)] capitalize">
                  {link.entityType}
                </p>
                <p className="text-[10px] font-mono text-[var(--color-text-muted)] truncate">{link.url}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                  Expires {formatDate(link.expiresAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(link.url)}
                className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-card)] transition-all duration-150 shrink-0"
                title="Copy link"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleRevoke(link.id)}
                disabled={revokeLink.isPending}
                className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-red)] hover:bg-[var(--color-red-bg)] transition-all duration-150 shrink-0 disabled:opacity-40"
                title="Revoke link"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// -- Settings Page Main ---------------------------------------------------------

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, theme, setTheme, logout } = useAuthStore();
  const { data: propertiesData } = useProperties();
  const properties = (propertiesData as unknown as { properties: { id: number; name: string }[] })?.properties
    ?? (propertiesData as unknown as { id: number; name: string }[])
    ?? [];

  // Tag management -- property selector
  const [selectedTagPropertyId, setSelectedTagPropertyId] = React.useState<number>(0);

  // Auto-select first property
  React.useEffect(() => {
    if (!selectedTagPropertyId && properties.length > 0) {
      setSelectedTagPropertyId(properties[0].id);
    }
  }, [properties, selectedTagPropertyId]);

  const themeOptions = [
    { key: 'light' as const, icon: Sun, label: 'Light' },
    { key: 'dark' as const, icon: Moon, label: 'Dark' },
    { key: 'system' as const, icon: Monitor, label: 'System' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="animate-fade-up"><TitleBar>Settings</TitleBar></h1>

      {/* Desktop: 2-column layout / Mobile: single column */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          {/* Profile -- collapsed by default */}
          <CollapsibleSettingsSection title="Profile" defaultOpen={false} animationDelay="0ms">
            {user ? (
              <div className="flex items-center gap-4">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.displayName}
                    className="w-14 h-14 rounded-full object-cover ring-2 ring-[var(--color-border)]"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center text-lg font-bold text-[var(--color-primary)]">
                    {user.displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="text-sm font-semibold text-[var(--color-text)]">{user.displayName}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">{user.email}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">Not signed in</p>
            )}
          </CollapsibleSettingsSection>

          {/* Theme -- expanded by default */}
          <Card animationDelay="50ms">
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Appearance</h2>
            <div className="flex gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
              {themeOptions.map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTheme(key)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[var(--radius-sm)] text-sm font-medium transition-all duration-200 cursor-pointer',
                    theme === key
                      ? 'bg-[var(--color-card)] text-[var(--color-primary)] shadow-sm'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </div>
          </Card>

          {/* Data — always visible. The Recycle Bin was buried in a collapsed
              accordion while every delete in the app funnels into it; and
              Reports lives here now instead of holding a permanent nav slot
              for a few-times-a-year export. */}
          <Card animationDelay="350ms">
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Data</h2>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => navigate('/recycle-bin')}
                className="flex items-center gap-2 text-sm text-[var(--color-text)] hover:text-[var(--color-primary)] transition-all duration-200 py-1.5"
              >
                <Trash2 className="w-4 h-4" />
                Recycle Bin
              </button>
              <button
                type="button"
                onClick={() => navigate('/reports')}
                className="flex items-center gap-2 text-sm text-[var(--color-text)] hover:text-[var(--color-primary)] transition-all duration-200 py-1.5"
              >
                <BarChart2 className="w-4 h-4" />
                Reports &amp; Exports
              </button>
            </div>
          </Card>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4 mt-4 lg:mt-0">
          {/* Tag Management with property pill selector */}
          {properties.length > 0 && (
            <Card animationDelay="100ms">
              <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3 flex items-center gap-2">
                <Tags className="w-4 h-4 text-[var(--color-primary)]" />
                Tag Management
              </h2>

              {/* Property pill bar */}
              <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
                {properties.map((property) => (
                  <button
                    key={property.id}
                    type="button"
                    onClick={() => setSelectedTagPropertyId(property.id)}
                    className={cn(
                      'px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200 shrink-0 border',
                      selectedTagPropertyId === property.id
                        ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                        : 'bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
                    )}
                  >
                    {property.name}
                  </button>
                ))}
              </div>

              {/* Show only selected property's tags */}
              {selectedTagPropertyId > 0 && (
                <TagManager propertyId={selectedTagPropertyId} />
              )}
            </Card>
          )}

          {/* Notifications with toggle switches */}
          <Card animationDelay="200ms">
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Notifications</h2>
            <NotificationPrefsRedesigned />
          </Card>

          {/* Printing -- printer registration, loaded roll, job queue */}
          {selectedTagPropertyId > 0 && (
            <Card animationDelay="250ms">
              <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Printing</h2>
              <PrinterSettings propertyId={selectedTagPropertyId} />
            </Card>
          )}

          {/* Share Links */}
          <ShareLinksSection />
        </div>
      </div>

      {/* Logout -- full width below */}
      <div className="border-t border-[var(--color-border)]/50" />
      <Button variant="destructive" onClick={logout} className="w-full lg:max-w-xs animate-fade-up" style={{ animationDelay: '400ms' }}>
        <LogOut className="w-4 h-4" />
        Sign Out
      </Button>
    </div>
  );
}
