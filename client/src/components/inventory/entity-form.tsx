import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type EntityType = 'property' | 'area' | 'container' | 'item';

interface EntityFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: EntityType;
  defaultValues?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void | Promise<unknown>;
  isPending?: boolean;
  /** Rendered between the field list and the submit row — e.g. a location
      section a caller owns. EntityForm knows nothing about its contents. */
  extraFields?: React.ReactNode;
  /** AND-ed with the form's own validity — a caller's veto, never a grant. */
  submitDisabled?: boolean;
}

/**
 * The shapes worth picking from a list. Not exhaustive by design — the column
 * is free text and stays that way, so "Other…" covers everything else rather
 * than this list having to anticipate every household.
 */
export const CONTAINER_TYPES = [
  'Box', 'Bin', 'Tote', 'Crate', 'Basket', 'Bag', 'Shelf', 'Drawer', 'Cabinet',
] as const;

/** Sentinel for the "Other…" option. Never reaches the form value — see the onChange. */
const OTHER = '__other__';

/**
 * The options to show, given what the record already holds.
 *
 * The column was free text before this dropdown existed, and one value is
 * still written by code: `findOrCreateLooseContainer` stamps type `'loose'` on
 * the synthetic per-area container. That is not something a user should be
 * able to pick, but editing such a container must not silently rewrite it —
 * so an unrecognised current value is prepended verbatim and round-trips.
 */
export function optionsWithCurrent(
  known: readonly string[],
  current: unknown,
): readonly string[] {
  if (typeof current === 'string' && current && !known.includes(current)) {
    return [current, ...known];
  }
  return known;
}

/** containers.TYPE is VARCHAR(50); the server's Joi schema agrees. */
const TYPE_MAX = 50;

interface FieldDef {
  name: string;
  label: string;
  required?: boolean;
  type?: string;
  /** Present = render a dropdown of these instead of a text box. */
  options?: readonly string[];
  /** Display text per option, where the stored value is not what to show. */
  optionLabels?: Record<string, string>;
  /**
   * The server validates this against a closed enum, so suppress "Other…".
   * Offering free text into an enum column just produces a 422 the user
   * cannot act on.
   */
  closed?: boolean;
}

const fieldsByType: Record<EntityType, FieldDef[]> = {
  property: [
    { name: 'name', label: 'Name', required: true },
    { name: 'address', label: 'Address' },
    { name: 'description', label: 'Description' },
  ],
  area: [
    { name: 'name', label: 'Name', required: true },
    { name: 'description', label: 'Description' },
  ],
  container: [
    { name: 'name', label: 'Name', required: true },
    { name: 'type', label: 'Type', required: true, options: CONTAINER_TYPES },
    { name: 'description', label: 'Description' },
  ],
  item: [
    { name: 'name', label: 'Name', required: true },
    { name: 'description', label: 'Description' },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'purchasePrice', label: 'Purchase Price', type: 'number' },
    { name: 'condition', label: 'Condition (new, good, fair, poor)' },
    {
      name: 'completeness',
      label: "What's here",
      options: ['complete', 'box_only', 'accessories_only'],
      optionLabels: {
        complete: 'The whole thing',
        box_only: 'Box only — item is elsewhere',
        accessories_only: 'Spares only — item is elsewhere',
      },
      closed: true,
    },
  ],
};

const titles: Record<EntityType, string> = {
  property: 'Property',
  area: 'Area',
  container: 'Container',
  item: 'Item',
};

export function EntityForm({
  open,
  onOpenChange,
  type,
  defaultValues,
  onSubmit,
  isPending,
  extraFields,
  submitDisabled,
}: EntityFormProps) {
  const { register, handleSubmit, reset, setValue, formState: { errors } } = useForm({
    defaultValues: defaultValues as Record<string, string>,
  });

  const fields = fieldsByType[type];
  const isEdit = !!defaultValues;

  // Which dropdown fields the user has switched to freehand entry. Kept in
  // component state rather than in the form value so only ONE name is ever
  // registered per field — the sentinel can never survive into the payload.
  const [customFields, setCustomFields] = React.useState<Record<string, boolean>>({});

  // A reopened dialog must not inherit the last session's "Other" mode.
  React.useEffect(() => {
    if (!open) setCustomFields({});
  }, [open]);

  const optionsFor = (field: FieldDef) =>
    optionsWithCurrent(field.options ?? [], defaultValues?.[field.name]);

  async function handleFormSubmit(data: Record<string, string>) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === '' || value == null) continue;
      const field = fields.find((f) => f.name === key);
      if (field?.type === 'number') {
        cleaned[key] = Number(value);
      } else {
        cleaned[key] = value;
      }
    }
    try {
      // Only reset + close once the submit resolves. If the parent returns a
      // rejecting promise (a failed mutation), keep the dialog open with the
      // user's input instead of discarding it.
      await onSubmit(cleaned);
      reset();
      onOpenChange(false);
    } catch {
      /* parent surfaces the error (toast); leave the form open */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit' : 'Create'} {titles[type]}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update the details below.' : `Add a new ${type} to your inventory.`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)} className="flex flex-col gap-3">
          {fields.map((field) => {
            const invalid = errors[field.name] ? true : undefined;
            const errClass = errors[field.name] ? 'border-[var(--color-red)]' : undefined;
            const requiredRule = field.required && `${field.label} is required`;

            // Composed rather than spread-then-overridden: register()'s own
            // onChange still has to run for every real value, or the field
            // never updates. Only the sentinel short-circuits it.
            // Guarded on the render branch, not just on `options`: in custom
            // mode the Input below registers the same name, and two register()
            // calls per render would leave the field's rules decided by call
            // order rather than by which control is actually mounted.
            const showSelect = !!field.options && !customFields[field.name];
            const selectReg = showSelect ? register(field.name, { required: requiredRule }) : null;

            return (
            <div key={field.name} className="flex flex-col gap-1">
              <label htmlFor={field.name} className="text-xs font-medium text-[var(--color-text-muted)]">
                {field.label}
                {field.required && <span className="text-[var(--color-red)]"> *</span>}
              </label>

              {showSelect ? (
                <Select
                  id={field.name}
                  aria-invalid={invalid}
                  className={errClass}
                  {...selectReg}
                  onChange={(e) => {
                    if (e.target.value === OTHER) {
                      setCustomFields((s) => ({ ...s, [field.name]: true }));
                      setValue(field.name, '', { shouldValidate: false });
                      return;
                    }
                    selectReg?.onChange(e);
                  }}
                >
                  <option value="">Select…</option>
                  {optionsFor(field).map((o) => (
                    <option key={o} value={o}>{field.optionLabels?.[o] ?? o}</option>
                  ))}
                  {!field.closed && <option value={OTHER}>Other…</option>}
                </Select>
              ) : field.options ? (
                <>
                  <Input
                    id={field.name}
                    autoFocus
                    placeholder="e.g. Wardrobe"
                    maxLength={TYPE_MAX}
                    aria-invalid={invalid}
                    className={errClass}
                    {...register(field.name, {
                      required: requiredRule,
                      maxLength: { value: TYPE_MAX, message: `Types are limited to ${TYPE_MAX} characters` },
                    })}
                  />
                  <button
                    type="button"
                    className="self-start text-xs text-[var(--color-primary)] underline"
                    onClick={() => {
                      setCustomFields((s) => ({ ...s, [field.name]: false }));
                      setValue(field.name, '', { shouldValidate: false });
                    }}
                  >
                    Choose from list
                  </button>
                </>
              ) : (
              <Input
                id={field.name}
                type={field.type || 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                // The label renderer now auto-fits and ellipsizes (it tightens
                // tracking, then shrinks, then truncates), so a long name no
                // longer breaks a label — it just prints shorter. A HARD 40
                // limit here meant an item auto-named from a product lookup
                // (often ~70 chars) could never be edited again: changing its
                // quantity failed validation on a name the user never typed.
                // The server's own limit is 255.
                maxLength={field.name === 'name' ? 255 : undefined}
                aria-invalid={invalid}
                className={errClass}
                {...register(field.name, {
                  required: requiredRule,
                  ...(field.name === 'name'
                    ? { maxLength: { value: 255, message: 'Names are limited to 255 characters' } }
                    : {}),
                })}
              />
              )}

              {errors[field.name] && (
                <span className="text-xs text-[var(--color-red)]">
                  {(errors[field.name]?.message as string) || `${field.label} is required`}
                </span>
              )}
            </div>
            );
          })}

          {extraFields}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || submitDisabled}>
              {isPending ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
