import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { EntityForm } from '@/components/inventory/entity-form';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useAreas, useCreateContainer, useProperties } from '@/hooks/use-inventory';

interface CreateContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when the current page already answers "where" — the section
      collapses to a confirmation line and these win over any selection. */
  seedAreaId?: number;
  seedAreaName?: string;
  seedPropertyId?: number;
}

/**
 * Lets a container be created from anywhere in the app, not just from inside
 * an area or another container's page. Composes the existing EntityForm
 * (type="container") with a "where does it live" section this file owns —
 * EntityForm never sees the area/property state, only `extraFields` (the
 * section's JSX) and `submitDisabled` (a veto until an area is chosen).
 *
 * When the caller already knows where the container goes (seedAreaId set —
 * e.g. the sidebar was opened from an area or container page), the section
 * collapses to a one-line confirmation instead of asking the user to repeat
 * a choice the current page already made.
 */
export function CreateContainerDialog({
  open, onOpenChange, seedAreaId, seedAreaName, seedPropertyId,
}: CreateContainerDialogProps) {
  const navigate = useNavigate();
  const { data: properties } = useProperties();
  const createContainer = useCreateContainer();

  const [propertyId, setPropertyId] = React.useState<number | undefined>(seedPropertyId);
  const effectivePropertyId = seedPropertyId ?? propertyId ?? properties?.[0]?.id;
  // Seeded flows already know the area, so there is nothing this hook needs
  // to fetch — `0` disables it via the hooks' own `enabled: !!id` idiom.
  const { data: areas } = useAreas(seedAreaId != null ? 0 : (effectivePropertyId ?? 0));
  const [areaId, setAreaId] = React.useState<number | undefined>(undefined);

  // This component stays mounted in the sidebar for the app's whole life —
  // only `open` toggles Radix's content in and out — so without this, a
  // closed-and-reopened dialog would keep showing whatever property/area the
  // user last picked instead of starting fresh.
  React.useEffect(() => {
    if (!open) { setPropertyId(seedPropertyId); setAreaId(undefined); }
  }, [open, seedPropertyId]);

  const seeded = seedAreaId != null;
  // A property with exactly one area needs no click: "where you're standing
  // is where it goes" already applies one level up (the sole-property case
  // below), and a mandatory pick from a one-option list serves nobody.
  const effectiveAreaId = seedAreaId ?? areaId ?? (areas?.length === 1 ? areas[0].id : undefined);
  // `useAreas` has no keepPreviousData, so switching properties blanks `data`
  // for the whole refetch — undefined means LOADING, not empty, and must not
  // flash the "no areas" guidance over a property that has some.
  const areasLoading = !seeded && areas === undefined;
  const noAreas = !seeded && areas !== undefined && areas.length === 0;
  const showPropertyButtons = !seeded && (properties?.length ?? 0) > 1;

  function submit(data: Record<string, unknown>) {
    return createContainer.mutateAsync(
      { ...data, areaId: effectiveAreaId } as {
        name: string; type: string; description?: string; areaId: number;
      },
    )
      .then((res) => {
        toast('Container created');
        onOpenChange(false);
        navigate(`/container/${res.container.id}`);
      })
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  const where = seeded ? (
    <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      Goes in <span className="text-[var(--color-text)]">{seedAreaName}</span>
    </p>
  ) : (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        Where does it live?
      </span>
      {showPropertyButtons && (
        <div className="flex flex-wrap gap-2">
          {properties!.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={p.id === effectivePropertyId ? 'default' : 'outline'}
              onClick={() => { setPropertyId(p.id); setAreaId(undefined); }}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}
      {noAreas ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          No areas here yet — create one on the Areas page first.
        </p>
      ) : (
        <Select
          aria-label="Area"
          value={effectiveAreaId ?? ''}
          onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : undefined)}
        >
          {areasLoading ? (
            <option value="" disabled>Loading areas…</option>
          ) : (
            <>
              <option value="">Pick an area…</option>
              {(areas ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </>
          )}
        </Select>
      )}
    </div>
  );

  return (
    <EntityForm
      open={open}
      onOpenChange={onOpenChange}
      type="container"
      onSubmit={submit}
      isPending={createContainer.isPending}
      extraFields={where}
      submitDisabled={effectiveAreaId == null}
    />
  );
}
