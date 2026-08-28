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
      pinnedDest: { id: 1, name: 'Bin A' },
      lastDest: { id: 1, name: 'Bin A' },
    });

    useCarryStore.getState().pickUp([{ id: 2, name: 'Widget' }]);

    const state = useCarryStore.getState();
    expect(state.carried).toEqual([{ id: 2, name: 'Widget' }]);
    // A new carry is a new decision — the old pin does not carry over.
    expect(state.pinnedDest).toBeNull();
    // But the session's memory of where things last went is not a decision
    // about THIS carry, so it survives.
    expect(state.lastDest).toEqual({ id: 1, name: 'Bin A' });
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
      toContainerId: 9,
      toContainerName: 'Bin C',
    });

    const state = useCarryStore.getState();
    expect(state.carried).toEqual([]);
    expect(state.pinnedDest).toEqual({ id: 9, name: 'Bin C' });
    expect(state.lastDest).toEqual({ id: 9, name: 'Bin C' });
  });

  it('completeMove sets both lastDest and pinnedDest to the destination, same as recordMove', () => {
    useCarryStore.getState().pickUp([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);

    useCarryStore.getState().completeMove([1], {
      items: [{ id: 1, name: 'A' }],
      toContainerId: 4,
      toContainerName: 'Tote',
    });

    const state = useCarryStore.getState();
    // Partial batch: only the moved entity leaves the carry.
    expect(state.carried).toEqual([{ id: 2, name: 'B' }]);
    expect(state.pinnedDest).toEqual({ id: 4, name: 'Tote' });
    expect(state.lastDest).toEqual({ id: 4, name: 'Tote' });
  });

  it('clearPin clears only the pin, leaving lastDest and the carry untouched', () => {
    useCarryStore.setState({
      carried: [{ id: 1, name: 'Widget' }],
      pinnedDest: { id: 1, name: 'Bin A' },
      lastDest: { id: 1, name: 'Bin A' },
    });

    useCarryStore.getState().clearPin();

    const state = useCarryStore.getState();
    expect(state.pinnedDest).toBeNull();
    expect(state.lastDest).toEqual({ id: 1, name: 'Bin A' });
    expect(state.carried).toEqual([{ id: 1, name: 'Widget' }]);
  });

  it('pinDest re-pins directly without moving anything or touching lastDest', () => {
    useCarryStore.getState().pickUp([{ id: 1, name: 'Widget' }]);

    useCarryStore.getState().pinDest({ id: 7, name: 'Bin D' });

    const state = useCarryStore.getState();
    expect(state.pinnedDest).toEqual({ id: 7, name: 'Bin D' });
    expect(state.lastDest).toBeNull();
    expect(state.carried).toEqual([{ id: 1, name: 'Widget' }]);
  });
});
