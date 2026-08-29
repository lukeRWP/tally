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
import { afterEach, expect, test, vi } from 'vitest';
import { Reports } from './reports';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: () => 'touch' }));

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
