import * as React from 'react';
import { Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { prepareImage } from '@/lib/image';
import { toast } from '@/components/ui/toast';
import { useCreateCondition } from '@/hooks/use-files';
import type { ConditionSnapshot } from '@/types/files';

type Condition = ConditionSnapshot['condition'];

const CONDITIONS: { value: Condition; label: string; variant: 'success' | 'default' | 'warning' | 'danger' }[] = [
  { value: 'new', label: 'New', variant: 'success' },
  { value: 'good', label: 'Good', variant: 'default' },
  { value: 'fair', label: 'Fair', variant: 'warning' },
  { value: 'poor', label: 'Poor', variant: 'danger' },
];

interface ConditionFormProps {
  itemId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

export function ConditionForm({ itemId, isOpen, onOpenChange, onComplete }: ConditionFormProps) {
  const photoInputRef = React.useRef<HTMLInputElement>(null);
  const [condition, setCondition] = React.useState<Condition>('good');
  const [notes, setNotes] = React.useState('');
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = React.useState<string | null>(null);

  const createCondition = useCreateCondition();

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    // Prepared at pick, not at submit, so the preview shows what will be sent
    // — and a HEIC from the iOS picker becomes a jpeg the route takes (#346).
    const file = picked ? await prepareImage(picked) : null;
    setPhoto(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPhotoPreview(url);
    } else {
      setPhotoPreview(null);
    }
  }

  function reset() {
    setCondition('good');
    setNotes('');
    setPhoto(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
  }

  async function handleSubmit() {
    try {
      await createCondition.mutateAsync({
        itemId,
        condition,
        notes: notes.trim() || undefined,
        photo: photo ?? undefined,
      });
      toast.success('Condition recorded');
      reset();
      onComplete();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record condition');
    }
  }

  // Clean up object URL on unmount
  React.useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) reset(); onOpenChange(open); }}>
      <DialogContent className="mx-4 max-w-sm">
        <DialogHeader>
          <DialogTitle>Record Condition</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Condition selector */}
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Condition</p>
            <div className="flex gap-2 flex-wrap">
              {CONDITIONS.map(({ value, label, variant }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCondition(value)}
                  className={cn(
                    'cursor-pointer rounded-full transition-opacity',
                    condition === value ? 'opacity-100 ring-2 ring-offset-1 ring-[var(--color-primary)]' : 'opacity-60 hover:opacity-80'
                  )}
                >
                  <Badge variant={variant}>{label}</Badge>
                </button>
              ))}
            </div>
          </div>

          {/* Photo picker */}
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Photo</p>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handlePhotoChange}
            />
            {photoPreview ? (
              <div className="relative w-full">
                <img
                  src={photoPreview}
                  alt="Preview"
                  className="w-full h-32 object-cover rounded-[var(--radius-md)] border border-[var(--color-border)]"
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-[var(--radius-md)] cursor-pointer"
                >
                  Change
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className={cn(
                  'w-full h-20 flex flex-col items-center justify-center gap-1',
                  'border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)]',
                  'text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)] transition-colors cursor-pointer'
                )}
              >
                <Camera className="w-5 h-5" />
                Take photo or choose from gallery
              </button>
            )}
          </div>

          {/* Notes */}
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes about condition…"
              rows={3}
              className={cn(
                'w-full px-3 py-2 rounded-[var(--radius-md)] border border-[var(--color-border)]',
                'bg-[var(--color-elevated)] text-sm text-[var(--color-text)]',
                'placeholder:text-[var(--color-text-muted)] resize-none',
                'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent'
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
            disabled={createCondition.isPending}
          >
            {createCondition.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
