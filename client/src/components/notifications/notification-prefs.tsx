import { Check } from 'lucide-react';
import { useNotificationPreferences, useUpdatePreference } from '@/hooks/use-notifications';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const NOTIFICATION_TYPES: Array<{ type: string; label: string }> = [
  { type: 'warranty_expiry', label: 'Warranty Expiration' },
  { type: 'lending_due', label: 'Lending Due/Overdue' },
  { type: 'item_moved', label: 'Item Moved' },
  { type: 'item_removed', label: 'Item Removed' },
  { type: 'share_expiring', label: 'Share Link Expiring' },
  { type: 'custom_date', label: 'Custom Date Approaching' },
];

/**
 * One preference, one ruled row, and the whole 44px row is the switch — the
 * name is the biggest thing on the line, so it has to be the thing you can hit.
 * The mark is an ink-filled 18px box, the same one the batch-select rows use:
 * a filled box takes its colour from the ink token and so inverts correctly on
 * either ground, where a thumb painted a hard white stays white on ink.
 */
function PrefRow({
  enabled,
  onChange,
  disabled,
  label,
}: {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-3 min-h-[44px] text-left border-b border-[var(--color-rule)] last:border-b-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
    >
      <span className="text-sm text-[var(--color-text)]">{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[2px] border-[1.6px] border-[var(--color-text)]',
          enabled ? 'bg-[var(--color-text)] text-[var(--color-bg)]' : 'text-transparent',
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    </button>
  );
}

export function NotificationPrefs() {
  const { data: prefs, isLoading } = useNotificationPreferences();
  const updatePref = useUpdatePreference();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        {NOTIFICATION_TYPES.map(({ type }) => (
          <Skeleton key={type} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {NOTIFICATION_TYPES.map(({ type, label }) => {
        // Notifications are opt-in (server default OFF), so default to false —
        // also the safe fallback if prefs fail to load.
        const enabled = prefs?.[type] ?? false;
        return (
          <PrefRow
            key={type}
            enabled={enabled}
            label={label}
            onChange={() => updatePref.mutate({ type, enabled: !enabled })}
            disabled={updatePref.isPending}
          />
        );
      })}
    </div>
  );
}
