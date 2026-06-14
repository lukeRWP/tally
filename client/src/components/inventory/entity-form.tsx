import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
}

const fieldsByType: Record<EntityType, { name: string; label: string; required?: boolean; type?: string }[]> = {
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
    { name: 'type', label: 'Type (e.g. box, shelf, drawer)', required: true },
    { name: 'description', label: 'Description' },
  ],
  item: [
    { name: 'name', label: 'Name', required: true },
    { name: 'description', label: 'Description' },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'purchasePrice', label: 'Purchase Price', type: 'number' },
    { name: 'condition', label: 'Condition (new, good, fair, poor)' },
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
}: EntityFormProps) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({
    defaultValues: defaultValues as Record<string, string>,
  });

  const fields = fieldsByType[type];
  const isEdit = !!defaultValues;

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
          {fields.map((field) => (
            <div key={field.name} className="flex flex-col gap-1">
              <label htmlFor={field.name} className="text-xs font-medium text-[var(--color-text-muted)]">
                {field.label}
                {field.required && <span className="text-[var(--color-red)]"> *</span>}
              </label>
              <Input
                id={field.name}
                type={field.type || 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                aria-invalid={errors[field.name] ? true : undefined}
                className={errors[field.name] ? 'border-[var(--color-red)]' : undefined}
                {...register(field.name, { required: field.required && `${field.label} is required` })}
              />
              {errors[field.name] && (
                <span className="text-xs text-[var(--color-red)]">
                  {(errors[field.name]?.message as string) || `${field.label} is required`}
                </span>
              )}
            </div>
          ))}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
