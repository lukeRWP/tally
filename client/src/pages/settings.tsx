import { LogOut, Sun, Moon, Monitor, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';
import { useProperties } from '@/hooks/use-inventory';
import { TagManager } from '@/components/tags/tag-manager';
import { NotificationPrefs } from '@/components/notifications/notification-prefs';

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
