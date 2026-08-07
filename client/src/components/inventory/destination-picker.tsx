import * as React from 'react';
import { X, MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { useProperties, useAreas, useContainers } from '@/hooks/use-inventory';

export interface PickedBin {
  id: number;
  name: string;
  areaId?: number;
}

/**
 * The keyboard path to a bin: property → area → bin.
 *
 * Every flow that asks "where does this go?" needs one, because the camera is
 * not always the answer — the bin may have no label yet, the label may be
 * damaged, permission may be denied, or you may simply know where it goes.
 * Shared so the create flow and the move flow ask the question identically.
 */
export function DestinationPicker({
  seedAreaId,
  seedPropertyId,
  onPick,
  onClose,
}: {
  /** Pre-select an area (e.g. the page you came from) so the bins are one tap away. */
  seedAreaId?: number;
  seedPropertyId?: number;
  onPick: (bin: PickedBin) => void;
  onClose: () => void;
}) {
  const [propertyId, setPropertyId] = React.useState(seedPropertyId ?? 0);
  const [areaId, setAreaId] = React.useState(seedAreaId ?? 0);

  const { data: properties } = useProperties();
  const { data: areas } = useAreas(propertyId);
  const { data: containers } = useContainers(areaId);

  // One property is the common case; pre-select it so the picker opens on areas.
  React.useEffect(() => {
    if (!propertyId && properties?.length === 1) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  // An area seeded without its property leaves the cascade blank, so backfill.
  React.useEffect(() => {
    if (!seedAreaId || propertyId) return;
    (async () => {
      try {
        const { area } = await api.get<{ area: { propertyId: number } }>(`/api/areas/_x_/${seedAreaId}`);
        if (area?.propertyId) setPropertyId(area.propertyId);
      } catch { /* the picker still works, it just starts at the property step */ }
    })();
  }, [seedAreaId, propertyId]);

  return (
    <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] font-bold">Choose a bin</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {(properties?.length ?? 0) > 1 && (
        <select
          value={propertyId}
          onChange={(e) => { setPropertyId(Number(e.target.value)); setAreaId(0); }}
          className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm"
        >
          <option value={0}>Property…</option>
          {properties?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}

      <select
        value={areaId}
        onChange={(e) => setAreaId(Number(e.target.value))}
        disabled={!propertyId}
        className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm disabled:opacity-50"
      >
        <option value={0}>Area…</option>
        {areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>

      {areaId > 0 && (
        (containers?.length ?? 0) === 0 ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-2">
            No bins in this area yet — scan its area label to file loose
          </p>
        ) : (
          <div className="flex flex-col max-h-56 overflow-y-auto">
            {containers?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick({ id: c.id, name: c.name, areaId: c.areaId })}
                className="flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0 text-left"
              >
                <MapPin className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                <span className="min-w-0 flex-1 text-sm font-medium truncate">{c.name}</span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{c.itemCount ?? 0}</span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
