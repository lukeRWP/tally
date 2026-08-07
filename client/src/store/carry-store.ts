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

/** A completed move, kept so the banner can offer a one-tap undo. */
export interface CompletedMove {
  items: CarriedItem[];
  toContainerId: number;
  toContainerName: string;
}

interface CarryState {
  carried: CarriedItem[];
  lastMove: CompletedMove | null;
  /** Replaces whatever was held — picking up is not additive by accident. */
  pickUp: (items: CarriedItem[]) => void;
  /** Adds to the held set (scanning a second item while already carrying). */
  addToCarry: (item: CarriedItem) => void;
  drop: (id: number) => void;
  clear: () => void;
  recordMove: (move: CompletedMove) => void;
  clearLastMove: () => void;
}

export const useCarryStore = create<CarryState>((set, get) => ({
  carried: [],
  lastMove: null,

  pickUp: (items) => set({ carried: items, lastMove: null }),

  addToCarry: (item) => {
    if (get().carried.some((c) => c.id === item.id)) return; // already in hand
    set({ carried: [...get().carried, item] });
  },

  drop: (id) => set({ carried: get().carried.filter((c) => c.id !== id) }),

  clear: () => set({ carried: [] }),

  // Recording a move both ends the carry and arms the undo.
  recordMove: (move) => set({ carried: [], lastMove: move }),

  clearLastMove: () => set({ lastMove: null }),
}));
