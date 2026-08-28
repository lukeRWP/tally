import { describe, it, expect, beforeEach } from 'vitest';
import { useCarryStore } from './carry-store';

/**
 * Plain vitest, no jsdom — this store is pure Zustand state, and its
 * transitions matter more than any component that renders it. Every case
 * here maps directly to a sentence in the store's own doc comments; if one
 * of those comments ever turns out to be wrong, one of these should fail.
 */

function resetStore() {
  useCarryStore.setState({
    carried: [],
    lastMove: null,
    pinnedDest: null,
    lastDest: null,
  });
}

describe('carry-store', () => {
  beforeEach(resetStore);

  it('pickUp replaces the carry and clears the pin, but leaves lastDest alone', () => {
    useCarryStore.setState({
      pinnedDest: { id: 1, name: 'Bin A', type: 'container' },
      lastDest: { id: 1, name: 'Bin A', type: 'container' },
    });

    useCarryStore.getState().pickUp([{ id: 2, name: 'Widget' }]);

    const state = useCarryStore.getState();
    expect(state.carried).toEqual([{ id: 2, name: 'Widget' }]);
    // A new carry is a new decision — the old pin does not carry over.
    expect(state.pinnedDest).toBeNull();
    // But the session's memory of where things last went is not a decision
    // about THIS carry, so it survives.
    expect(state.lastDest).toEqual({ id: 1, name: 'Bin A', type: 'container' });
  });

  it('addToCarry dedupes — scanning the same code twice does not duplicate the entry', () => {
    const { addToCarry } = useCarryStore.getState();
    addToCarry({ id: 5, name: 'Widget' });
    addToCarry({ id: 5, name: 'Widget' });

    expect(useCarryStore.getState().carried).toEqual([{ id: 5, name: 'Widget' }]);
  });

  it('recordMove sets both lastDest and pinnedDest to the destination — a landing pins it', () => {
    useCarryStore.getState().pickUp([{ id: 1, name: 'Widget' }]);

    useCarryStore.getState().recordMove({
      items: [{ id: 1, name: 'Widget' }],
      to: { id: 9, name: 'Bin C', type: 'container' },
    });

    const state = useCarryStore.getState();
    expect(state.carried).toEqual([]);
    expect(state.pinnedDest).toEqual({ id: 9, name: 'Bin C', type: 'container' });
    expect(state.lastDest).toEqual({ id: 9, name: 'Bin C', type: 'container' });
  });

  it('completeMove sets both lastDest and pinnedDest to the destination, same as recordMove', () => {
    useCarryStore.getState().pickUp([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);

    useCarryStore.getState().completeMove([1], {
      items: [{ id: 1, name: 'A' }],
      to: { id: 4, name: 'Tote', type: 'container' },
    });

    const state = useCarryStore.getState();
    // Partial batch: only the moved entity leaves the carry.
    expect(state.carried).toEqual([{ id: 2, name: 'B' }]);
    expect(state.pinnedDest).toEqual({ id: 4, name: 'Tote', type: 'container' });
    expect(state.lastDest).toEqual({ id: 4, name: 'Tote', type: 'container' });
  });

  it('completeMove preserves an AREA-typed destination verbatim — a bins-only landing pins the area itself, not a container', () => {
    // The exact shape usePutDown builds when a bins-only batch lands on an
    // area's own id (no items, so no loose container is ever created) — the
    // caller's `type` has to be trusted, not re-derived from the id alone,
    // since a container id and an area id can collide (independent
    // AUTO_INCREMENT sequences).
    useCarryStore.getState().pickUp([{ id: 1, name: 'Small Bin', kind: 'container' }]);

    useCarryStore.getState().completeMove([1], {
      items: [{ id: 1, name: 'Small Bin', kind: 'container' }],
      to: { id: 4, name: 'Garage', type: 'area' },
    });

    const state = useCarryStore.getState();
    expect(state.pinnedDest).toEqual({ id: 4, name: 'Garage', type: 'area' });
    expect(state.lastDest).toEqual({ id: 4, name: 'Garage', type: 'area' });
  });

  it('clearPin clears only the pin, leaving lastDest and the carry untouched', () => {
    useCarryStore.setState({
      carried: [{ id: 1, name: 'Widget' }],
      pinnedDest: { id: 1, name: 'Bin A', type: 'container' },
      lastDest: { id: 1, name: 'Bin A', type: 'container' },
    });

    useCarryStore.getState().clearPin();

    const state = useCarryStore.getState();
    expect(state.pinnedDest).toBeNull();
    expect(state.lastDest).toEqual({ id: 1, name: 'Bin A', type: 'container' });
    expect(state.carried).toEqual([{ id: 1, name: 'Widget' }]);
  });

  it('pinDest re-pins directly without moving anything or touching lastDest', () => {
    useCarryStore.getState().pickUp([{ id: 1, name: 'Widget' }]);

    useCarryStore.getState().pinDest({ id: 7, name: 'Bin D', type: 'container' });

    const state = useCarryStore.getState();
    expect(state.pinnedDest).toEqual({ id: 7, name: 'Bin D', type: 'container' });
    expect(state.lastDest).toBeNull();
    expect(state.carried).toEqual([{ id: 1, name: 'Widget' }]);
  });

  it('pinDest carries an AREA re-pin through untouched', () => {
    useCarryStore.getState().pinDest({ id: 3, name: 'Garage', type: 'area' });

    expect(useCarryStore.getState().pinnedDest).toEqual({ id: 3, name: 'Garage', type: 'area' });
  });
});
