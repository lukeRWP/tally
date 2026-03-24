import { useNotificationPreferences, useUpdatePreference } from '@/hooks/use-notifications';
import { cn } from '@/lib/utils';

const NOTIFICATION_TYPES: Array<{ type: string; label: string }> = [
  { type: 'warranty_expiry', label: 'Warranty Expiration' },
  { type: 'lending_due', label: 'Lending Due/Overdue' },
  { type: 'item_moved', label: 'Item Moved' },
  { type: 'item_removed', label: 'Item Removed' },
  { type: 'share_expiring', label: 'Share Link Expiring' },
  { type: 'custom_date', label: 'Custom Date Approaching' },
];

function ToggleSwitch({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'relative w-10 h-6 rounded-full transition-colors duration-200 shrink-0 cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        enabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]',
      )}
    >
      <span
        className={cn(
          'absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200',
          enabled ? 'translate-x-5' : 'translate-x-1',
        )}
      />
    </button>
  );
}

export function NotificationPrefsRedesigned() {
  const { data: prefs, isLoading } = useNotificationPreferences();
  const updatePref = useUpdatePreference();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {NOTIFICATION_TYPES.map(({ type }) => (
          <div key={type} className="h-10 rounded-[var(--radius-md)] bg-[var(--color-elevated)] animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {NOTIFICATION_TYPES.map(({ type, label }) => {
        const enabled = prefs ? (prefs[type] ?? true) : true;
        return (
          <div key={type} className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--color-text)]">{label}</span>
            <ToggleSwitch
              enabled={enabled}
              onChange={() => updatePref.mutate({ type, enabled: !enabled })}
              disabled={updatePref.isPending}
            />
          </div>
        );
      })}
    </div>
  );
}
