import { LogOut, Sun, Moon, Monitor, Trash2, Link2, Copy } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';
import { useProperties } from '@/hooks/use-inventory';
import { TagManager } from '@/components/tags/tag-manager';
import { NotificationPrefs } from '@/components/notifications/notification-prefs';
import { useMyShareLinks, useRevokeShareLink } from '@/hooks/use-sharing';
import { toast } from '@/components/ui/toast';

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

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
    <Card>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-[var(--color-primary)]" />
        Share Links
      </h2>

      {isLoading && (
        <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
      )}

      {!isLoading && allLinks.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">No active share links.</p>
      )}

      {!isLoading && allLinks.length > 0 && (
        <div className="flex flex-col gap-2">
          {allLinks.map((link) => (
            <div
              key={link.id}
              className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] border border-[var(--color-border)]"
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
                className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors shrink-0"
                title="Copy link"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleRevoke(link.id)}
                disabled={revokeLink.isPending}
                className="p-1 rounded text-[var(--color-red)] hover:opacity-80 transition-opacity shrink-0 disabled:opacity-40"
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

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, theme, setTheme, logout } = useAuthStore();
  const { data: propertiesData } = useProperties();
  const properties = (propertiesData as unknown as { properties: { id: number; name: string }[] })?.properties
    ?? (propertiesData as unknown as { id: number; name: string }[])
    ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-[var(--color-text)]">Settings</h1>

      {/* Profile */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Profile</h2>
        {user ? (
          <div className="flex items-center gap-3">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.displayName}
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center text-sm font-bold text-[var(--color-primary)]">
                {user.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">{user.displayName}</p>
              <p className="text-xs text-[var(--color-text-muted)]">{user.email}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">Not signed in</p>
        )}
      </Card>

      {/* Theme */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Appearance</h2>
        <div className="flex gap-2">
          <Button
            variant={theme === 'light' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('light')}
            className="flex-1"
          >
            <Sun className="w-4 h-4" />
            Light
          </Button>
          <Button
            variant={theme === 'dark' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('dark')}
            className="flex-1"
          >
            <Moon className="w-4 h-4" />
            Dark
          </Button>
          <Button
            variant={theme === 'system' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('system')}
            className="flex-1"
          >
            <Monitor className="w-4 h-4" />
            System
          </Button>
        </div>
      </Card>

      {/* Tag Management */}
      {properties.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Tag Management</h2>
          <div className="flex flex-col gap-6">
            {properties.map((property) => (
              <div key={property.id}>
                <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">{property.name}</p>
                <TagManager propertyId={property.id} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Notifications */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Notifications</h2>
        <NotificationPrefs />
      </Card>

      {/* Share Links */}
      <ShareLinksSection />

      {/* Recycle Bin */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Data</h2>
        <button
          type="button"
          onClick={() => navigate('/recycle-bin')}
          className="flex items-center gap-2 text-sm text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          Recycle Bin
        </button>
      </Card>

      {/* Logout */}
      <Button variant="destructive" onClick={logout} className="w-full">
        <LogOut className="w-4 h-4" />
        Sign Out
      </Button>
    </div>
  );
}
