/**
 * #283 — the rail surfaced one of the app's three global states. Carrying gets
 * a docked panel and alerts get a count; printing, the one flow you queue and
 * walk away from, got nothing, so a stopped printer was discovered by chance.
 *
 * What is pinned here is the predicate behind the badge: which queue states
 * are a person's problem, and which are just a printer being switched off.
 */
import { expect, test, describe } from 'vitest';
import { printAttentionCount } from './use-print';
import type { PrintJob, Printer } from './use-print';

const NOW = Date.parse('2026-08-29T12:00:00Z');

function job(status: PrintJob['status'], id = 1): PrintJob {
  return { id, entityType: 'item', entityIds: [id], preset: 'small', status, attempts: 0, lastError: null, createdAt: '2026-08-29T10:00:00Z' };
}

function printer(over: Partial<Printer> = {}): Printer {
  return {
    id: 5, propertyId: 1, name: 'Garage Pi', loadedMedia: 'small',
    printerState: 'idle', printerStateReasons: [],
    lastSeenAt: '2026-08-29T11:59:30Z', // 30s ago — online
    ...over,
  };
}

describe('printAttentionCount', () => {
  test('nothing queued and nothing wrong is not a badge', () => {
    expect(printAttentionCount([job('done'), job('canceled', 2)], [printer()], NOW)).toBe(0);
  });

  test('a failed job always counts', () => {
    expect(printAttentionCount([job('failed')], [printer()], NOW)).toBe(1);
  });

  test('a held job counts — the wrong roll is loaded and only a person can fix it', () => {
    expect(printAttentionCount([job('held')], [printer()], NOW)).toBe(1);
  });

  test('queued work with a live printer is just work in progress', () => {
    expect(printAttentionCount([job('queued'), job('claimed', 2)], [printer()], NOW)).toBe(0);
  });

  test('queued work with a STOPPED printer is the walk-away failure', () => {
    const out = printAttentionCount(
      [job('queued'), job('claimed', 2)],
      [printer({ printerState: 'stopped', printerStateReasons: ['media-empty'] })],
      NOW,
    );
    expect(out).toBe(2);
  });

  test('queued work with an agent that stopped calling in counts too', () => {
    const stale = printer({ lastSeenAt: '2026-08-29T11:50:00Z' }); // 10 min ago
    expect(printAttentionCount([job('queued')], [stale], NOW)).toBe(1);
  });

  test('an agent seen 59 seconds ago is still alive; 61 is not', () => {
    expect(printAttentionCount([job('queued')], [printer({ lastSeenAt: '2026-08-29T11:59:01Z' })], NOW)).toBe(0);
    expect(printAttentionCount([job('queued')], [printer({ lastSeenAt: '2026-08-29T11:58:59Z' })], NOW)).toBe(1);
  });

  test('an offline printer with an EMPTY queue is a printer that is off, not an alert', () => {
    expect(printAttentionCount([job('done')], [printer({ printerState: 'stopped' })], NOW)).toBe(0);
    expect(printAttentionCount([], [], NOW)).toBe(0);
  });

  test('queued work with no agent registered at all will never print, so it counts', () => {
    expect(printAttentionCount([job('queued')], [], NOW)).toBe(1);
  });

  test('an agent that has never called in is not alive', () => {
    expect(printAttentionCount([job('queued')], [printer({ lastSeenAt: null })], NOW)).toBe(1);
  });

  test('one live printer is enough, even beside a dead one', () => {
    expect(
      printAttentionCount([job('queued')], [printer({ id: 6, printerState: 'stopped' }), printer()], NOW),
    ).toBe(0);
  });

  test('failed and held add up alongside stranded queued work', () => {
    expect(
      printAttentionCount(
        [job('failed'), job('held', 2), job('queued', 3)],
        [printer({ printerState: 'stopped' })],
        NOW,
      ),
    ).toBe(3);
  });

  test('undefined data (the queries have not landed) is not an alert', () => {
    expect(printAttentionCount(undefined, undefined, NOW)).toBe(0);
  });
});
