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
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Reports } from './reports';

let layoutMode: 'touch' | 'sidebar' = 'touch';
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => layoutMode }));

// The property list the page is given, and whether it has arrived — #283 added
// an empty state, and an empty state must never be shown for a list that is
// merely still in flight.
let properties: { id: number; name: string; areaCount: number; containerCount: number; itemCount: number }[] = [];
let propertiesLoading = false;

beforeEach(() => {
  layoutMode = 'touch';
  properties = [{ id: 1, name: 'Home', areaCount: 0, containerCount: 0, itemCount: 0 }];
  propertiesLoading = false;
  preview = { data: { reportType: 'insurance', propertyId: 1, data: [] }, isPending: false, isError: false };
});

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useProperties: () => ({
      data: properties,
      isLoading: propertiesLoading,
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
// The preview query's state, swapped per test. `summariseReport` itself is the
// real one (use-reports.test.ts covers it row shape by row shape) — what is
// exercised here is that the page asks for it and prints the answer.
let preview: { data: unknown; isPending: boolean; isError: boolean };
const previewMock = vi.fn();
vi.mock('@/hooks/use-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-reports')>();
  return {
    ...actual,
    useGenerateReport: () => ({ mutate: mutateMock, isPending: false }),
    useReportPreview: (...args: unknown[]) => {
      previewMock(...args);
      return preview;
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  return render(<MemoryRouter><Reports /></MemoryRouter>);
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

  // 'location' is the client's old name for 'area' and never existed on the
  // server. 'condition' is on this list because the server implements it now
  // (#285) — it was offered here for years doing nothing, and #263 pulled it
  // rather than leave a button that 422s.
  expect(screen.queryByRole('button', { name: /^location$/i })).toBeNull();
  for (const opt of ['property', 'area', 'tag', 'condition']) {
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

/**
 * #283, first finding — `useReportPreview` and its route were both built and
 * neither was ever called: `grep -rn useReportPreview client/src` returned the
 * definition only. A desk's one advantage over a phone is seeing a thing
 * before committing to it, and the page spent 6% of a 1440 screen not doing so.
 */
describe('the preview beside Generate', () => {
  test('an opened report asks for its own preview, and only its own', () => {
    renderPage();
    expect(previewMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));

    // One call, for the one report being considered — not six on page load.
    const types = new Set(previewMock.mock.calls.map((c) => c[0]));
    expect([...types]).toEqual(['insurance']);
    expect(previewMock.mock.calls[0][1]).toBe(1); // propertyId
  });

  test('the count and total are printed where the decision is made', () => {
    preview = {
      data: { reportType: 'insurance', propertyId: 1, data: [{ currentValue: 34900 }, { currentValue: 0 }] },
      isPending: false,
      isError: false,
    };
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));

    expect(container.querySelector('[data-report-summary]')?.textContent).toBe('2 items · $34,900');
  });

  test('the tag report previews the tags actually ticked — its answer depends on them', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /tag report/i }));
    previewMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /tools/i }));

    expect(previewMock.mock.calls.at(-1)?.[2]).toMatchObject({ tagIds: [7] });
  });

  test('a report with no tag selector never sends tagIds', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));
    expect(previewMock.mock.calls[0][2]).toMatchObject({ tagIds: undefined });
  });

  /**
   * #310, secondary half — the preview sent the tags but never the grouping,
   * and the route defaults to `property`, so with "tag" selected the number
   * beside Generate was the total for a report nobody was about to generate.
   */
  test('Total Value previews the grouping actually selected', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /total value/i }));
    expect(previewMock.mock.calls.at(-1)?.[2]).toMatchObject({ groupBy: 'area' });

    previewMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^tag$/i }));
    expect(previewMock.mock.calls.at(-1)?.[2]).toMatchObject({ groupBy: 'tag' });
  });

  test('a report with no grouping control never sends groupBy', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));
    expect(previewMock.mock.calls[0][2]).toMatchObject({ groupBy: undefined });
  });

  test('a preview that fails says so and does NOT block Generate — it is an aid, not a gate', () => {
    preview = { data: undefined, isPending: false, isError: true };
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));

    expect(container.querySelector('[data-report-summary]')?.textContent).toBe('Preview unavailable');
    const generate = screen.getByRole('button', { name: /generate/i }) as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    fireEvent.click(generate);
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * #283, second finding — every report downloaded as `tally-<type>-report.<ext>`,
 * so two properties produced byte-different PDFs with identical names and a
 * year of insurance reports collided in one downloads folder.
 */
test('Generate hands the property name down so the file can be named for it', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: /insurance summary/i }));
  fireEvent.click(screen.getByRole('button', { name: /generate/i }));

  expect(mutateMock.mock.calls[0][0]).toMatchObject({ propertyId: 1, propertyName: 'Home' });
});

/**
 * #283, third finding — with no properties the page printed "No properties
 * available" and then rendered all six reports anyway. Expanding any of them
 * said "Pick a property above to configure this report"; there was nothing
 * above, and no route out.
 */
describe('with no properties', () => {
  test('the six reports you cannot run are not offered at all', () => {
    properties = [];
    const { container } = renderPage();

    expect(container.querySelectorAll('[data-report-row]').length).toBe(0);
    expect(screen.queryByRole('button', { name: /insurance summary/i })).toBeNull();
    expect(screen.queryByText(/no properties available/i)).toBeNull();
  });

  test('it names the missing link in the chain and offers the next action', () => {
    properties = [];
    renderPage();

    expect(screen.getByText(/no property yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /set up a place/i })).toBeTruthy();
  });

  test('a list that has not arrived yet is not an empty house', () => {
    properties = [];
    propertiesLoading = true;
    renderPage();

    // Neither the menu nor the "you have nothing" verdict — just the skeleton.
    expect(screen.queryByText(/no property yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /insurance summary/i })).toBeNull();
  });
});

/**
 * #315: this header is a hand-rolled copy of RuledRow's row styling (see the
 * comment above it for why it can't just BE one) — so it hand-rolled the same
 * focus bug too, and needs the same fix: a visible ring, not the elevated tint
 * that also means "pressed". See ui/ruled-row.test.tsx for the sibling case.
 */
test('the report row header has a visible focus ring, not the pressed tint', () => {
  renderPage();

  const header = screen.getByRole('button', { name: /insurance summary/i });
  const cls = header.className;

  expect(cls).toContain('focus-visible:ring-2');
  expect(cls).toContain('focus-visible:ring-inset');
  expect(cls).toContain('focus-visible:ring-[var(--color-primary)]');
  expect(cls).not.toContain('focus-visible:bg-[var(--color-elevated)]');
});
