import { useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { useMoveItem, useMoveContainer, type MoveConsequences } from './use-inventory';
import { useCarryStore, type CarriedItem } from '@/store/carry-store';
import type { Container } from '@/types/inventory';

/** The shape of a resolved TLY label, narrowed to what a destination needs. */
export interface PutDownTarget {
  type: string;
  id: number;
  name: string;
}

/**
 * The name given to the auto-created catch-all container for an area.
 * Clamped to the server's 255-char NAME limit, which an area name close to its
 * own 255 limit would otherwise blow past — a 422 that would repeat on every
 * scan of that area's label. Lookup and create must clamp identically or the
 * find half would never match what the create half wrote.
 */
const NAME_MAX = 255;
export const looseNameFor = (areaName: string) =>
  `Loose in ${areaName}`.slice(0, NAME_MAX);

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

/**
 * Asked once per entity that 409s on a lossy cross-property move. `index`/
 * `total` are 0-based/count, so the caller can say "this is 2 of 5" — a
 * single-entity load is just a batch of one, so callers that don't care can
 * ignore them and the sheet stays exactly as it was for that case.
 */
export type ConfirmPrompt = (
  entity: CarriedItem,
  index: number,
  total: number,
  consequences: MoveConsequences,
) => Promise<'confirm' | 'cancel'>;

/** What a completed (possibly partial) put-down says to the user, and how it is undone. */
export interface PutDownResult {
  /** Entities that actually landed on the destination — what recordMove covers. */
  moved: CarriedItem[];
  /** Entities the user explicitly declined ("not this one") — still carried. */
  skipped: CarriedItem[];
  destinationName: string;
  targetId: number;
  /** Summed across every moved entity that crossed a property. */
  unlinkedCount: number;
  tagsCarried: number;
  /** True if ANY moved entity crossed a property — drives the "moved to the
   * other property" wording vs the plain one. */
  crossProperty: boolean;
  /**
   * True if the batch stopped on a non-409 error before reaching the end of
   * the load. `moved`/`skipped` still describe everything attempted before
   * the stop; whatever wasn't reached yet is neither — it's just still
   * carried, same as a skip.
   */
  aborted: boolean;
  abortError?: unknown;
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
 *
 * A batch is NOT all-or-nothing. Each entity is attempted in turn; a 409 on
 * one (a lossy cross-property move) pauses THAT entity — via confirmPrompt,
 * which the caller uses to show the confirm sheet and awaits the user's
 * decision — without abandoning the rest of the load. Confirming re-sends
 * just that entity with confirm:true and the loop resumes; cancelling skips
 * it (it stays carried, stays put) and the loop still resumes. Only a real
 * (non-409) error stops the batch early, and even then whatever already
 * moved is reconciled truthfully rather than left claimed by a stale carry.
 */
export function usePutDown() {
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();
  const completeMove = useCarryStore((s) => s.completeMove);

  return useCallback(
    async (
      load: CarriedItem[],
      dest: PutDownTarget,
      confirmPrompt: ConfirmPrompt,
    ): Promise<PutDownResult | null> => {
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

      // Items are filtered against the container they will actually land in,
      // which for an area is its catch-all bin — so that has to be resolved
      // first (once, shared by every item in the load — not re-created per
      // item). Comparing fromContainerId to an AREA id would be meaningless
      // (the two tables have independent id sequences), and skipping the check
      // would file items into the bin they were picked up from and log a move
      // that never happened. Resolving first cannot litter: if the catch-all
      // had to be created, nothing could have come from it.
      let itemTarget: { id: number; name: string } | null = null;
      if (items.length > 0) {
        itemTarget = isArea
          ? await findOrCreateLooseContainer(dest.id, dest.name)
          : { id: dest.id, name: dest.name };
      }
      const target = itemTarget;
      const itemsToMove = target ? items.filter((i) => i.fromContainerId !== target.id) : [];

      const attempted = [...binsToMove, ...itemsToMove];
      if (attempted.length === 0) return null;

      const moved: CarriedItem[] = [];
      const skipped: CarriedItem[] = [];
      let unlinkedCount = 0;
      let tagsCarried = 0;
      let crossProperty = false;
      let aborted = false;
      let abortError: unknown;

      for (let i = 0; i < attempted.length; i++) {
        const entity = attempted[i];
        const isBin = entity.kind === 'container';
        let confirmed = false;
        // Retry loop for ONE entity: attempt unconfirmed, and on a 409 that
        // names unlinked accessories, ask (pausing here, not the whole
        // batch) — confirm retries this same entity, cancel drops out to
        // the outer loop having moved nothing for it.
        for (;;) {
          try {
            const res = isBin
              ? await moveContainer.mutateAsync(
                  isArea
                    ? { id: entity.id, parentContainerId: null, areaId: dest.id, confirm: confirmed }
                    : { id: entity.id, parentContainerId: dest.id, confirm: confirmed },
                )
              : await moveItem.mutateAsync({
                  id: entity.id, containerId: (target as { id: number }).id, confirm: confirmed,
                });
            moved.push(entity);
            if (res.consequences) {
              crossProperty = true;
              unlinkedCount += res.consequences.unlinked.length;
              tagsCarried += res.consequences.tagsCarried;
            }
            break;
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              const body = err.errors as MoveConsequences | undefined;
              if (body?.unlinked) {
                const decision = await confirmPrompt(entity, i, attempted.length, body);
                if (decision === 'confirm') { confirmed = true; continue; }
                skipped.push(entity);
                break;
              }
            }
            aborted = true;
            abortError = err;
            break;
          }
        }
        if (aborted) break;
      }

      // Reconcile truthfully: only what actually moved leaves the carry.
      // Skipped entities and anything never reached (the batch stopped
      // early) stay carried and visible — the carry store must never claim
      // a load "put down" that is still half in the user's hands.
      if (moved.length > 0) {
        completeMove(moved.map((m) => m.id), {
          items: moved,
          // Undo needs the container items actually landed in, but the
          // receipt should name the place the user scanned.
          toContainerId: itemTarget?.id ?? dest.id,
          toContainerName: dest.name,
          unlinkedCount,
        });
      }

      return {
        moved, skipped, destinationName: dest.name,
        targetId: itemTarget?.id ?? dest.id,
        unlinkedCount, tagsCarried, crossProperty, aborted, abortError,
      };
    },
    [moveItem, moveContainer, completeMove],
  );
}
