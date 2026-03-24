import { Button } from '@/components/ui/button';
import { useNotificationPreferences, useUpdatePreference } from '@/hooks/use-notifications';

const NOTIFICATION_TYPES: Array<{ type: string; label: string }> = [
  { type: 'warranty_expiry', label: 'Warranty Expiration' },
  { type: 'lending_due', label: 'Lending Due/Overdue' },
  { type: 'item_moved', label: 'Item Moved' },
  { type: 'item_removed', label: 'Item Removed' },
  { type: 'share_expiring', label: 'Share Link Expiring' },
  { type: 'custom_date', label: 'Custom Date Approaching' },
];

export function NotificationPrefs() {
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
            <Button
              variant={enabled ? 'default' : 'outline'}
              size="sm"
              onClick={() => updatePref.mutate({ type, enabled: !enabled })}
              disabled={updatePref.isPending}
              className="min-w-[56px]"
            >
              {enabled ? 'On' : 'Off'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
