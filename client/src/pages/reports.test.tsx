// @vitest-environment jsdom
/**
 * Reports page (#123): every control inside an expanded report's options
 * panel — the CSV/PDF format toggle, Generate — must fire normally and must
 * NOT collapse the card. The row's toggle button is scoped to the header
 * trigger only (icon + label/description + chevron); the options panel
 * renders as a sibling below it, so nothing inside the panel is a DOM
 * descendant of that button and a click there can never bubble into
 * `toggleReport`. This mirrors item-detail's collapsible `Section`, whose
 * toggle button likewise wraps only its header row, never the body below.
 *
 * These tests lock that structure in place rather than change it — see the
 * task report for why no production code changed here.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Reports } from './reports';

let layoutMode: 'touch' | 'sidebar' = 'touch';
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => layoutMode }));

beforeEach(() => {
  layoutMode = 'touch';
});

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});

// The Tag Report's panel renders TagMultiSelect, which is the one control here
// that fetches — without this it throws for want of a QueryClientProvider.
vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return {
    ...actual,
    usePropertyTags: () => ({ data: [{ id: 7, name: 'Tools', color: '#f60' }], isLoading: false }),
  };
});

const mutateMock = vi.fn();
vi.mock('@/hooks/use-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-reports')>();
  return {
    ...actual,
    useGenerateReport: () => ({ mutate: mutateMock, isPending: false }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  return render(<Reports />);
}

test('a control inside an expanded card (CSV export) fires and the card stays expanded', () => {
  renderPage();

  const header = screen.getByRole('button', { name: /insurance summary/i });
  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');

  // Switch to CSV, then trigger the export — the exact control #123 said was
  // unreachable.
  fireEvent.click(screen.getByRole('button', { name: /^csv$/i }));
  fireEvent.click(screen.getByRole('button', { name: /generate/i }));

  expect(mutateMock).toHaveBeenCalledTimes(1);
  expect(mutateMock.mock.calls[0][0]).toMatchObject({
    reportType: 'insurance',
    propertyId: 1,
    format: 'csv',
  });

  // None of those clicks bubbled into the toggle — the card is still open.
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: /generate/i })).toBeTruthy();
});

test('the header still opens and closes the card', () => {
  renderPage();

  const header = screen.getByRole('button', { name: /insurance summary/i });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();

  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: /generate/i })).toBeTruthy();

  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
});

/**
 * #263 — the report ids and groupBy values posted to the server. Four of the
 * six reports used to send a spelling the Joi enum has never accepted
 * (`total-value`, `by-location`, `activity`, `tags`) and every groupBy option
 * offered (`location`/`tag`/`condition`) missed too, so Generate answered a
 * "Validation failed" toast and no file. The server's own route tests
 * (server/test/reports.routes.test.js) read these ids back out of this file;
 * what is asserted here is that the button actually posts them.
 */
const EXPECTED_PAYLOAD_IDS = [
  ['Insurance Summary', 'insurance'],
  ['Total Value', 'total_value'],
  ['Items by Location', 'items_by_location'],
  ['Lending Report', 'lending'],
  ['Activity Log', 'activity_log'],
  ['Tag Report', 'tag'],
] as const;

test.each(EXPECTED_PAYLOAD_IDS)('%s generates with reportType "%s"', (label, id) => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
  fireEvent.click(screen.getByRole('button', { name: /generate/i }));

  expect(mutateMock).toHaveBeenCalledTimes(1);
  expect(mutateMock.mock.calls[0][0].reportType).toBe(id);
});

test('Total Value offers only groupBy values the server implements', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: /total value/i }));

  // 'condition' was offered for as long as the page has existed and was never
  // grouped by anything on the server — it is not a rename, it never worked.
  expect(screen.queryByRole('button', { name: /^condition$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^location$/i })).toBeNull();
  for (const opt of ['property', 'area', 'tag']) {
    expect(screen.getByRole('button', { name: new RegExp(`^${opt}$`, 'i') })).toBeTruthy();
  }

  fireEvent.click(screen.getByRole('button', { name: /^area$/i }));
  fireEvent.click(screen.getByRole('button', { name: /generate/i }));
  expect(mutateMock.mock.calls[0][0]).toMatchObject({ reportType: 'total_value', groupBy: 'area' });
});

/**
 * #275 — opening a report used to re-flow the whole desk menu. The six rows sat
 * in one row-major `grid grid-cols-2`, where every grid row is as tall as its
 * tallest cell, so an options panel opened in the right column pushed the next
 * row down and left an equally tall void in the left one: four rows jumped
 * 239px at 1440×900.
 *
 * jsdom does no layout, so what is pinned here is the structure that makes the
 * jump impossible — two INDEPENDENT column stacks rather than cells of a shared
 * grid. A row can only move a sibling inside its own stack.
 */
function columnsOf(container: HTMLElement) {
  // Each row wrapper is tagged with its report id; its parent is the stack.
  const rows = Array.from(container.querySelectorAll('[data-report-row]'));
  const stacks = new Map<Element, string[]>();
  for (const row of rows) {
    const parent = row.parentElement!;
    if (!stacks.has(parent)) stacks.set(parent, []);
    stacks.get(parent)!.push(row.getAttribute('data-report-row')!);
  }
  return Array.from(stacks.values());
}

test('at a desk the six rows are two independent stacks, not cells of one grid', () => {
  layoutMode = 'sidebar';
  const { container } = renderPage();

  // 1/3/5 beside 2/4/6 puts each pair side by side exactly where the row-major
  // grid put it, so the reading order the desk layout was designed around is
  // unchanged.
  expect(columnsOf(container)).toEqual([
    ['insurance', 'items_by_location', 'activity_log'],
    ['total_value', 'lending', 'tag'],
  ]);
});

test('opening a report never moves a row in the facing column', () => {
  layoutMode = 'sidebar';
  const { container } = renderPage();
  const before = columnsOf(container);

  // Total Value is the first row of the RIGHT column — the exact case in #275,
  // where opening it pushed all four rows below it down and blanked the left.
  fireEvent.click(screen.getByRole('button', { name: /total value/i }));

  expect(columnsOf(container)).toEqual(before);
  // The panel lives inside Total Value's own row, so it can only ever displace
  // the two rows beneath it in the right-hand stack.
  const panel = screen.getByRole('button', { name: /generate/i }).closest('[data-report-row]');
  expect(panel?.getAttribute('data-report-row')).toBe('total_value');
});

test('on a phone the rows stay a single stack', () => {
  const { container } = renderPage();
  expect(columnsOf(container)).toEqual([[
    'insurance', 'total_value', 'items_by_location', 'lending', 'activity_log', 'tag',
  ]]);
});
