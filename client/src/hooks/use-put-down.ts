import { useCallback, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useMoveItem, useMoveContainer, type MoveConsequences } from './use-inventory';
import { useCarryStore, type CarriedItem, type PinnedTarget } from '@/store/carry-store';
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
 * `total` are 0-based/count into the WHOLE batch (not just the entities that
 * needed a decision), so the caller can say "this is 2 of 5" — a
 * single-entity load is just a batch of one, so callers that don't care can
 * ignore them and the sheet stays exactly as it was for that case.
 *
 * The resolution carries `applyToRest`: checking "apply to the rest of this
 * batch" on the sheet means this same `choice` should be used for every
 * OTHER entity still waiting on a decision, with no further prompts. The
 * batch loop (below) is the only thing that reads it.
 */
export type ConfirmPrompt = (
  entity: CarriedItem,
  index: number,
  total: number,
  consequences: MoveConsequences,
) => Promise<{ choice: 'confirm' | 'cancel'; applyToRest: boolean }>;

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
   * True if any entity in the batch hit a real (non-409) error, in either
   * pass. Unlike the old sequential loop, this no longer stops the rest of
   * the batch — pass 1 already fired every entity at once, and pass 2 still
   * resolves everything that needed a decision — it just means the
   * reconciliation is not 100% clean. `abortError` is the FIRST such error
   * encountered (in load order), for the toast to name; later ones are
   * still counted in `aborted` but not individually surfaced.
   */
  aborted: boolean;
  abortError?: unknown;
  /**
   * How many entities hard-failed (a real, non-409 error, in either pass).
   * `aborted` alone can't tell a caller "11 of 12 moved" from "0 of 12
   * moved" — a batch that partially lands must say so truthfully rather
   * than reusing the same all-or-nothing failure toast for both. Counts
   * every hard failure, not just the first (unlike `abortError`).
   */
  failedCount: number;
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
 * A batch is NOT all-or-nothing, and it is not sequential either. PASS 1
 * fires the WHOLE load at once (Promise.allSettled, confirm:false) — most
 * entities land there. Anything that 409s on a lossy cross-property move
 * drops into PASS 2, a sequential loop that asks confirmPrompt one at a
 * time, in load order, ONLY for those. Confirming re-sends just that entity
 * with confirm:true; cancelling skips it (it stays carried, stays put).
 * Checking "apply to the rest of this batch" on any one of those prompts
 * folds every OTHER entity still waiting into a single batched resend
 * (confirm) or skip (cancel) — no more prompts after that. A real (non-409)
 * error, in either pass, never stops anything else from being attempted —
 * it is recorded as a hard failure and reported once the whole batch has
 * settled, not retried. Whatever actually moved is reconciled truthfully
 * rather than left claimed by a stale carry, exactly as before.
 *
 * `progress` tracks entity-settlements (not API calls) across both passes,
 * so it is always `{done, total}` with `done` climbing to `total` exactly
 * once per entity in the load, whichever pass finally resolves it.
 */
export function usePutDown() {
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();
  const completeMove = useCarryStore((s) => s.completeMove);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const putDown = useCallback(
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
      let failedCount = 0;

      const total = attempted.length;
      setProgress({ done: 0, total });
      // Counts entity-settlements, never API calls — an entity that needed a
      // PASS 2 decision only bumps once, when PASS 2 finally resolves it, not
      // again for its PASS 1 rejection. Math.min is a belt-and-suspenders
      // guard: the label must never read N of M with N > M.
      const bump = () => setProgress((p) => (p ? { done: Math.min(p.done + 1, total), total } : p));

      // One entity's raw attempt, dispatched by kind — shared by both passes
      // so PASS 2's confirmed resend (individual or batched) is the exact
      // same call as PASS 1's unconfirmed one, just with confirm:true.
      const attemptMove = (entity: CarriedItem, confirmed: boolean) =>
        entity.kind === 'container'
          ? moveContainer.mutateAsync(
              isArea
                ? { id: entity.id, parentContainerId: null, areaId: dest.id, confirm: confirmed }
                : { id: entity.id, parentContainerId: dest.id, confirm: confirmed },
            )
          : moveItem.mutateAsync({
              id: entity.id, containerId: (target as { id: number }).id, confirm: confirmed,
            });

      const applyOutcome = (entity: CarriedItem, res: { consequences: MoveConsequences | null }) => {
        moved.push(entity);
        if (res.consequences) {
          crossProperty = true;
          unlinkedCount += res.consequences.unlinked.length;
          tagsCarried += res.consequences.tagsCarried;
        }
      };

      const recordHardFailure = (err: unknown) => {
        // First one wins — it is what the caller's toast names. Later hard
        // failures in the same batch still count toward `aborted` (and
        // `failedCount`) being right, they just are not individually named.
        failedCount++;
        if (!aborted) { aborted = true; abortError = err; }
      };

      try {
        // PASS 1 — fire the whole load at once, unconfirmed. This is the
        // fast path nearly everything takes.
        const settledPass1 = await Promise.allSettled(
          attempted.map((entity) => attemptMove(entity, false)),
        );

        const needConfirm: { entity: CarriedItem; index: number; consequences: MoveConsequences }[] = [];
        settledPass1.forEach((outcome, i) => {
          const entity = attempted[i];
          if (outcome.status === 'fulfilled') {
            applyOutcome(entity, outcome.value);
            bump();
            return;
          }
          const err = outcome.reason;
          const body = err instanceof ApiError && err.status === 409
            ? (err.errors as MoveConsequences | undefined)
            : undefined;
          if (body?.unlinked) {
            // Not final yet — PASS 2 decides this one's fate, so no bump here.
            needConfirm.push({ entity, index: i, consequences: body });
          } else {
            recordHardFailure(err);
            bump();
          }
        });

        // PASS 2 — sequential, ONLY over what PASS 1 couldn't settle on its
        // own, in load order (matching `index` above). A resolution that
        // carries applyToRest folds everything still waiting into one
        // batched resend (confirm) or skip (cancel) and ends the loop —
        // no more prompts after that.
        for (let j = 0; j < needConfirm.length; j++) {
          const { entity, index, consequences } = needConfirm[j];
          const decision = await confirmPrompt(entity, index, total, consequences);

          if (decision.applyToRest) {
            const rest = needConfirm.slice(j);
            if (decision.choice === 'confirm') {
              const settledRest = await Promise.allSettled(
                rest.map((r) => attemptMove(r.entity, true)),
              );
              settledRest.forEach((outcome, k) => {
                if (outcome.status === 'fulfilled') {
                  applyOutcome(rest[k].entity, outcome.value);
                } else {
                  // A repeat 409 (or any other error) on a confirmed
                  // re-send is a hard failure, not another prompt — the
                  // user already said "apply to the rest".
                  recordHardFailure(outcome.reason);
                }
                bump();
              });
            } else {
              rest.forEach((r) => { skipped.push(r.entity); bump(); });
            }
            break;
          }

          if (decision.choice === 'cancel') {
            skipped.push(entity);
            bump();
            continue;
          }

          try {
            const res = await attemptMove(entity, true);
            applyOutcome(entity, res);
          } catch (err) {
            // Confirmed once, failed again — a hard failure, not another
            // prompt (same "do not retry" rule PASS 1 applies to a fresh
            // rejected-other).
            recordHardFailure(err);
          } finally {
            bump();
          }
        }
      } finally {
        setProgress(null);
      }

      // Reconcile truthfully: only what actually moved leaves the carry.
      // Skipped entities and anything that hard-failed stay carried and
      // visible — the carry store must never claim a load "put down" that
      // is still half in the user's hands.
      if (moved.length > 0) {
        // The TRUE type of where this landed — not `dest.type` blindly.
        // Whenever the load had any items, itemTarget is always a real
        // container (either dest itself, or the "Loose in <area>" bin
        // findOrCreateLooseContainer resolved) — never the area's own id.
        // Only a bins-only load (itemTarget stays null) can land AT an
        // area's own id, and only then does the pin's type mirror dest's.
        const to: PinnedTarget = itemTarget
          ? { id: itemTarget.id, name: dest.name, type: 'container' }
          : { id: dest.id, name: dest.name, type: dest.type === 'area' ? 'area' : 'container' };
        completeMove(moved.map((m) => m.id), { items: moved, to, unlinkedCount });
      }

      return {
        moved, skipped, destinationName: dest.name,
        targetId: itemTarget?.id ?? dest.id,
        unlinkedCount, tagsCarried, crossProperty, aborted, abortError, failedCount,
      };
    },
    [moveItem, moveContainer, completeMove],
  );

  return { putDown, progress };
}
