import { create } from 'zustand';

/**
 * "One carried object" — the state behind the move flow.
 *
 * Picking things up (from an item page, or from a container's select mode) and
 * putting them down (by scanning a destination label) are separated by an
 * arbitrary amount of walking and navigating, so the carried set cannot live in
 * a page's local state. It lives here, a banner renders it from the layout, and
 * any screen that resolves a container can complete the move.
 *
 * Deliberately NOT persisted to localStorage: carrying is a physical, in-the-
 * moment act. A set of items still "in hand" after a browser restart would be a
 * lie about where things are — the one thing an inventory app must not do.
 * The same applies to pinnedDest and lastDest below: both describe where the
 * CURRENT session is headed, not a fact about the inventory, so a restart
 * should forget them exactly as it forgets the carry itself.
 */

export interface CarriedItem {
  id: number;
  name: string;
  /**
   * Items move between containers; containers move between areas or nest
   * inside another container. Both are "carried", and the destination decides
   * which operation runs — so the kind must travel with the load.
   */
  kind?: 'item' | 'container';
  /** Where it was picked up from, so the receipt can say "Bin 4 → Tote". */
  fromContainerId?: number;
  fromContainerName?: string;
  /**
   * A container sitting at an area's top level has no parent container, so its
   * origin — and therefore its undo — is an area.
   */
  fromAreaId?: number;
}

/**
 * Somewhere a load can land: a container, or an area (bins re-home to an
 * area's top level; items land in the area's catch-all container instead —
 * see findOrCreateLooseContainer). The type has to travel WITH the id,
 * never be inferred from it later: containers and areas are independent
 * AUTO_INCREMENT sequences, so an id alone is ambiguous, and in a populated
 * household a numeric collision between them is the common case, not an
 * edge case. Guessing wrong here doesn't 404 — it silently addresses an
 * unrelated entity.
 */
export interface PinnedTarget {
  id: number;
  name: string;
  type: 'container' | 'area';
}

/** A completed move, kept so the banner can offer a one-tap undo. */
export interface CompletedMove {
  items: CarriedItem[];
  to: PinnedTarget;
  /**
   * Set when the move crossed properties and had to sever cross-property
   * accessory links to go through. Undo puts the load back in its old
   * container, but it cannot re-link what was severed — the undo toast has
   * to say so rather than imply a full undo.
   */
  unlinkedCount?: number;
}

interface CarryState {
  carried: CarriedItem[];
  lastMove: CompletedMove | null;
  /**
   * A landing pins the destination — staying to distribute is the default,
   * leaving is explicit. Set by recordMove/completeMove (a successful
   * landing pins itself) and by pinDest (the distribute-mode re-pin: scanning
   * a new bin/area code without moving anything). Cleared by clearPin (the
   * explicit "Done, leave" act) and by pickUp (a new carry is a new decision
   * — the pin from whatever was landed before does not apply to a fresh
   * load).
   */
  pinnedDest: PinnedTarget | null;
  /**
   * Session memory only; the one-tap default when nothing is pinned. Unlike
   * pinnedDest, picking up a fresh load does NOT clear this — it is not a
   * decision about the current carry, just a fading memory of where things
   * were going last, offered back in case it still applies.
   */
  lastDest: PinnedTarget | null;
  /** Replaces whatever was held — picking up is not additive by accident. */
  pickUp: (items: CarriedItem[]) => void;
  /** Adds to the held set (scanning a second item while already carrying). */
  addToCarry: (item: CarriedItem) => void;
  drop: (id: number) => void;
  clear: () => void;
  recordMove: (move: CompletedMove) => void;
  /**
   * The partial-batch-move counterpart to recordMove: drops exactly the
   * entities that actually moved and arms undo for just those, leaving
   * everything else (skipped past a declined confirm, or never reached
   * because the batch stopped on a real error) sitting in `carried` — a
   * batch move is not all-or-nothing, so ending the carry can't be either.
   */
  completeMove: (movedIds: number[], move: CompletedMove) => void;
  clearLastMove: () => void;
  /**
   * Re-pins without moving anything — distribute mode scanning a new
   * bin/area code to redirect where the NEXT scanned item goes.
   */
  pinDest: (dest: PinnedTarget) => void;
  /** Leaving is the explicit act; this is it. */
  clearPin: () => void;
}

export const useCarryStore = create<CarryState>((set, get) => ({
  carried: [],
  lastMove: null,
  pinnedDest: null,
  lastDest: null,

  // A new carry is a new decision, so the OLD pin no longer applies — but
  // lastDest is session memory, not a decision, so it survives untouched.
  pickUp: (items) => set({ carried: items, lastMove: null, pinnedDest: null }),

  addToCarry: (item) => {
    if (get().carried.some((c) => c.id === item.id)) return; // already in hand
    set({ carried: [...get().carried, item] });
  },

  drop: (id) => set({ carried: get().carried.filter((c) => c.id !== id) }),

  clear: () => set({ carried: [] }),

  // Recording a move both ends the carry and arms the undo. Only correct when
  // the WHOLE load moved — see completeMove for a partial batch. Landing
  // pins the destination (see pinnedDest) and refreshes the session memory
  // of where things last went (see lastDest) — both point at the same
  // place, and `move.to` is already the authoritative {id, name, type} the
  // caller resolved (usePutDown knows whether it landed items in a real
  // container or bins at an area's top level) — never re-derived here.
  recordMove: (move) => set({
    carried: [],
    lastMove: move,
    pinnedDest: move.to,
    lastDest: move.to,
  }),

  completeMove: (movedIds, move) => set((s) => ({
    carried: s.carried.filter((c) => !movedIds.includes(c.id)),
    lastMove: move,
    pinnedDest: move.to,
    lastDest: move.to,
  })),

  clearLastMove: () => set({ lastMove: null }),

  pinDest: (dest) => set({ pinnedDest: dest }),

  clearPin: () => set({ pinnedDest: null }),
}));
