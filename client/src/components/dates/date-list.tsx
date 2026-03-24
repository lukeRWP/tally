import * as React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { DateForm } from './date-form';
import { useItemDates, useDeleteDate, type ItemDate } from '@/hooks/use-dates';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface DateListProps {
  itemId: number;
}

export function DateList({ itemId }: DateListProps) {
  const { data: dates, isLoading } = useItemDates(itemId);
  const deleteDate = useDeleteDate();

  const [editingDate, setEditingDate] = React.useState<ItemDate | null>(null);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!dates || dates.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-1">No dates recorded.</p>
    );
  }

  function handleDelete(dateItem: ItemDate) {
    if (!window.confirm(`Delete "${dateItem.dateType}" date?`)) return;
    deleteDate.mutate(
      { dateId: dateItem.id, itemId },
      {
        onSuccess: () => toast.success('Date deleted'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
      },
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {dates.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between border-b border-[var(--color-border)] pb-2 last:border-0 gap-2"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-xs font-semibold text-[var(--color-text)]">{d.dateType}</p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {formatDate(d.dateValue)}
              </p>
              {d.notes && (
                <p className="text-xs text-[var(--color-text-muted)] line-clamp-1">{d.notes}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setEditingDate(d)}
                className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleDelete(d)}
                className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-red)] transition-colors cursor-pointer"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editingDate && (
        <DateForm
          itemId={itemId}
          isOpen={!!editingDate}
          onOpenChange={(open) => { if (!open) setEditingDate(null); }}
          defaultValues={editingDate}
        />
      )}
    </>
  );
}
