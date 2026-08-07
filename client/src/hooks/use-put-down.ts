import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useMoveItem, useMoveContainer } from './use-inventory';
import { useCarryStore, type CarriedItem } from '@/store/carry-store';
import type { Container } from '@/types/inventory';

/** The shape of a resolved TLY label, narrowed to what a destination needs. */
export interface PutDownTarget {
  type: string;
  id: number;
  name: string;
}

/** The name given to the auto-created catch-all container for an area. */
export const looseNameFor = (areaName: string) => `Loose in ${areaName}`;

/**
 * Items must live in a container — the schema has no "item sitting in a room".
 * So a scanned area label resolves to that area's catch-all container, created
 * on first use. Matching by name (not a flag column) keeps this a plain
 * container the user can rename, relabel, or delete like any other.
 */
export async function findOrCreateLooseContainer(
  areaId: number,
  areaName: string,
): Promise<Container> {
  const wanted = looseNameFor(areaName).trim().toLowerCase();
  const { containers } = await api.get<{ containers: Container[] }>(
    `/api/containers/_x_/area/${areaId}`,
  );
  const existing = containers?.find((c) => c.name.trim().toLowerCase() === wanted);
  if (existing) return existing;

  const { container } = await api.post<{ container: Container }>(
    '/api/containers/_y_/create',
    { name: looseNameFor(areaName), type: 'loose', areaId },
  );
  return container;
}

/** What a completed put-down says to the user, and how it is undone. */
export interface PutDownResult {
  moved: CarriedItem[];
  destinationName: string;
}

/**
 * Puts the carried load down on a scanned destination.
 *
 * One load can hold items, containers, or both, and one destination can be a
 * container or an area — so the rule is a 2x2, and it lives here rather than in
 * each screen that can complete a move:
 *
 *              → container            → area
 *   items      move into it           move into "Loose in <area>"
 *   containers nest inside it         re-home to the area's top level
 */
export function usePutDown() {
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();
  const recordMove = useCarryStore((s) => s.recordMove);

  return useCallback(
    async (load: CarriedItem[], dest: PutDownTarget): Promise<PutDownResult | null> => {
      const bins = load.filter((c) => c.kind === 'container');
      // kind is optional for back-compat: an unlabelled load is items.
      const items = load.filter((c) => c.kind !== 'container');

      // A container cannot go inside itself, and the load may already be where
      // it is being put — both are no-ops, not errors. "Already there" for a bin
      // moved to an area means top level of that area: a bin nested three deep
      // in the same area still has somewhere to go.
      const isArea = dest.type === 'area';
      const binsToMove = bins.filter((b) =>
        isArea
          ? !(b.fromAreaId === dest.id && !b.fromContainerId)
          : b.id !== dest.id && b.fromContainerId !== dest.id,
      );
      const itemsToMove = items.filter((i) => isArea || i.fromContainerId !== dest.id);

      if (binsToMove.length === 0 && itemsToMove.length === 0) return null;

      // Only mint the catch-all container if items actually need one.
      let itemTarget: { id: number; name: string } | null = null;
      if (itemsToMove.length > 0) {
        if (isArea) {
          const loose = await findOrCreateLooseContainer(dest.id, dest.name);
          itemTarget = { id: loose.id, name: loose.name };
        } else {
          itemTarget = { id: dest.id, name: dest.name };
        }
      }

      for (const bin of binsToMove) {
        await moveContainer.mutateAsync(
          isArea
            ? { id: bin.id, parentContainerId: null, areaId: dest.id }
            : { id: bin.id, parentContainerId: dest.id },
        );
      }
      for (const it of itemsToMove) {
        await moveItem.mutateAsync({ id: it.id, containerId: (itemTarget as { id: number }).id });
      }

      const moved = [...binsToMove, ...itemsToMove];
      recordMove({
        items: moved,
        // Undo needs the container items actually landed in, but the receipt
        // should name the place the user scanned.
        toContainerId: itemTarget?.id ?? dest.id,
        toContainerName: dest.name,
      });
      return { moved, destinationName: dest.name };
    },
    [moveItem, moveContainer, recordMove],
  );
}
