import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useCreateDate, useUpdateDate, type ItemDate } from '@/hooks/use-dates';

const DATE_TYPE_SUGGESTIONS = [
  'Purchased',
  'Warranty expires',
  'Last serviced',
  'Inspection due',
];

interface DateFormProps {
  itemId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  defaultValues?: ItemDate;
}

export function DateForm({ itemId, isOpen, onOpenChange, defaultValues }: DateFormProps) {
  const isEdit = !!defaultValues;

  const [dateType, setDateType] = React.useState(defaultValues?.dateType ?? '');
  const [dateValue, setDateValue] = React.useState(defaultValues?.dateValue?.split('T')[0] ?? '');
  const [notes, setNotes] = React.useState(defaultValues?.notes ?? '');
  const [showSuggestions, setShowSuggestions] = React.useState(false);

  const suggestionsRef = React.useRef<HTMLDivElement>(null);

  const createDate = useCreateDate();
  const updateDate = useUpdateDate();

  // Sync defaults when they change (e.g. opening edit mode with new data)
  React.useEffect(() => {
    if (isOpen && defaultValues) {
      setDateType(defaultValues.dateType ?? '');
      setDateValue(defaultValues.dateValue?.split('T')[0] ?? '');
      setNotes(defaultValues.notes ?? '');
    }
  }, [isOpen, defaultValues]);

  // Close suggestions on outside click
  React.useEffect(() => {
    if (!showSuggestions) return;
    function handleClick(e: MouseEvent) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSuggestions]);

  function reset() {
    setDateType('');
    setDateValue('');
    setNotes('');
    setShowSuggestions(false);
  }

  const filteredSuggestions = DATE_TYPE_SUGGESTIONS.filter((s) =>
    s.toLowerCase().includes(dateType.toLowerCase()),
  );

  async function handleSubmit() {
    if (!dateType.trim()) {
      toast.error('Please enter a date type');
      return;
    }
    if (!dateValue) {
      toast.error('Please select a date');
      return;
    }
    try {
      if (isEdit && defaultValues) {
        await updateDate.mutateAsync({
          dateId: defaultValues.id,
          itemId,
          dateType: dateType.trim(),
          dateValue,
          notes: notes.trim() || undefined,
        });
        toast.success('Date updated');
      } else {
        await createDate.mutateAsync({
          itemId,
          dateType: dateType.trim(),
          dateValue,
          notes: notes.trim() || undefined,
        });
        toast.success('Date added');
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save date');
    }
  }

  const isPending = createDate.isPending || updateDate.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) reset(); onOpenChange(open); }}>
      <DialogContent className="mx-4 max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Date' : 'Add Date'}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="relative" ref={suggestionsRef}>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Date type</p>
            <Input
              placeholder="e.g. Purchased, Warranty expires"
              value={dateType}
              onChange={(e) => setDateType(e.target.value)}
              onFocus={() => setShowSuggestions(true)}
              autoFocus={!isEdit}
            />
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-lg overflow-hidden">
                {filteredSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      setDateType(suggestion);
                      setShowSuggestions(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors cursor-pointer"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Date</p>
            <input
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              className={cn(
                'w-full bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1',
              )}
            />
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={3}
              className={cn(
                'w-full px-3 py-2 rounded-[var(--radius-md)] border border-[var(--color-border)]',
                'bg-[var(--color-elevated)] text-sm text-[var(--color-text)]',
                'placeholder:text-[var(--color-text-muted)] resize-none',
                'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent',
              )}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { reset(); onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isPending}
          >
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
