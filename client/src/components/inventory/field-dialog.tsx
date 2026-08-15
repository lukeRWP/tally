import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

/**
 * Change one fact.
 *
 * The ledger's whole idea is a page of individual facts, each with its own
 * "edit" or "+ add" — and every one of them opened the same combined form with
 * Name, Description, Quantity, Price and Condition in it. Pressing edit on
 * Quantity and being handed five fields is a different question from the one
 * asked, and it puts four values you did not intend to touch one stray
 * keystroke from being saved.
 *
 * So: one row, one field, one dialog. The combined form still exists behind the
 * page's own Edit button, which is where "change several things" belongs.
 */
export type FieldKind = 'text' | 'number' | 'money' | 'multiline';

export function FieldDialog({
  open, onOpenChange, label, kind = 'text', value, hint, pending, onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Shown as the title — the same word the ledger row uses, so the dialog is
      recognisably about the row you pressed. */
  label: string;
  kind?: FieldKind;
  value: string | number | null | undefined;
  hint?: string;
  pending?: boolean;
  /** Null means "clear it" — an empty box is a legitimate answer for an
      optional fact, and is how you take a value back off. */
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = React.useState('');

  // Re-seed each time it opens: reusing the last edit's text would offer the
  // wrong value for the row that is actually open.
  React.useEffect(() => {
    if (open) setDraft(value == null ? '' : String(value));
  }, [open, value]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    onSave(t === '' ? null : t);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          {hint && <DialogDescription>{hint}</DialogDescription>}
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {kind === 'multiline' ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1"
            />
          ) : (
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              type={kind === 'text' ? 'text' : 'number'}
              step={kind === 'money' ? '0.01' : kind === 'number' ? '1' : undefined}
              min={kind === 'number' || kind === 'money' ? 0 : undefined}
              inputMode={kind === 'money' ? 'decimal' : kind === 'number' ? 'numeric' : undefined}
            />
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
