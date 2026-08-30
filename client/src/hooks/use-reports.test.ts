/**
 * #283 — the two pure pieces of the reports loop: what the downloaded file is
 * called, and the one line that says what is in it before you commit.
 *
 * Every `summariseReport` fixture below is the shape
 * `server/src/modules/reports/reports.service.js` actually returns for that
 * report type; a summariser tested against a convenient invention is a
 * summariser that lies in production.
 */
import { expect, test, describe } from 'vitest';
import { reportFilename, summariseReport } from './use-reports';

const AUG_29 = new Date(2026, 7, 29, 22, 30); // local time, deliberately late

describe('reportFilename', () => {
  test('names the property and the day', () => {
    expect(reportFilename('insurance', 'pdf', 'Rockwood', AUG_29)).toBe(
      'tally-insurance-rockwood-2026-08-29.pdf',
    );
  });

  test('two properties on the same day no longer collide', () => {
    const a = reportFilename('insurance', 'pdf', 'Rockwood', AUG_29);
    const b = reportFilename('insurance', 'pdf', 'Lock-up on Mill Road', AUG_29);
    expect(a).not.toBe(b);
    expect(b).toBe('tally-insurance-lock-up-on-mill-road-2026-08-29.pdf');
  });

  test('the same property on two days no longer collides', () => {
    expect(reportFilename('insurance', 'pdf', 'Rockwood', new Date(2026, 8, 1))).toBe(
      'tally-insurance-rockwood-2026-09-01.pdf',
    );
  });

  test('the date is the reader\'s local day, not UTC — 22:30 is still the 29th', () => {
    expect(reportFilename('lending', 'csv', 'Rockwood', AUG_29)).toContain('2026-08-29');
  });

  test('a property name that slugifies to nothing is dropped, not left as a stray dash', () => {
    expect(reportFilename('tag', 'csv', '???', AUG_29)).toBe('tally-tag-2026-08-29.csv');
  });

  test('no property name at all still yields a dated file', () => {
    expect(reportFilename('activity_log', 'csv', undefined, AUG_29)).toBe(
      'tally-activity_log-2026-08-29.csv',
    );
  });

  test('the extension follows the format', () => {
    expect(reportFilename('insurance', 'csv', 'Rockwood', AUG_29).endsWith('.csv')).toBe(true);
    expect(reportFilename('insurance', 'pdf', 'Rockwood', AUG_29).endsWith('.pdf')).toBe(true);
  });
});

describe('summariseReport', () => {
  test('insurance counts rows and totals their current value', () => {
    expect(
      summariseReport('insurance', [
        { currentValue: 100 },
        { currentValue: 34800 },
        { currentValue: null },
      ]),
    ).toBe('3 items · $34,900');
  });

  test('total_value adds the groups up and says what the report leaves out', () => {
    expect(
      summariseReport('total_value', [
        { group: 'Garage', itemCount: 400, currentTotal: 30000, excludedCount: 3 },
        { group: 'Office', itemCount: 82, currentTotal: 4900, excludedCount: 0 },
      ]),
    ).toBe('482 items · $34,900 · 3 part-only excluded');
  });

  test('total_value stays quiet when nothing was excluded', () => {
    expect(summariseReport('total_value', [{ itemCount: 2, currentTotal: 10, excludedCount: 0 }]))
      .toBe('2 items · $10');
  });

  test('items_by_location counts items down the whole container tree', () => {
    expect(
      summariseReport('items_by_location', [
        {
          areaName: 'Garage',
          containers: [
            { items: [{}, {}], children: [{ items: [{}], children: [] }] },
            { items: [], children: [] },
          ],
        },
        { areaName: 'Office', containers: [{ items: [{}], children: [] }] },
      ]),
    ).toBe('2 areas · 4 items');
  });

  test('lending flags the overdue ones', () => {
    expect(summariseReport('lending', [{ overdue: true }, { overdue: false }])).toBe('2 items out · 1 overdue');
    expect(summariseReport('lending', [{ overdue: false }])).toBe('1 item out');
  });

  test('activity_log counts changes', () => {
    expect(summariseReport('activity_log', [{}, {}, {}])).toBe('3 changes');
  });

  test('tag counts both the tags and their items', () => {
    expect(
      summariseReport('tag', [{ items: [{}, {}] }, { items: [{}] }]),
    ).toBe('2 tags · 3 items');
  });

  test('an empty report says so rather than saying nothing — that IS the warning', () => {
    expect(summariseReport('insurance', [])).toBe('0 items · $0');
    expect(summariseReport('activity_log', [])).toBe('0 changes');
  });

  test('singular where it matters', () => {
    expect(summariseReport('insurance', [{ currentValue: 5 }])).toBe('1 item · $5');
  });

  test('a shape it does not recognise answers null rather than guessing', () => {
    expect(summariseReport('insurance', null)).toBeNull();
    expect(summariseReport('insurance', { rows: [] })).toBeNull();
    expect(summariseReport('insurance', undefined)).toBeNull();
  });
});
