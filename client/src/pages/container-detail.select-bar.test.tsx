// @vitest-environment jsdom
/**
 * Pins the fix round for #267 (Space silently discarding the whole
 * selection) and #276 (the count truncating to 2px, and the bar burying the
 * last row) — plus the combined carrying+selecting overlap a follow-up
 * review found still unaddressed, now fixed via the shared bottom-stack
 * model (use-bottom-stack.ts, its own test file).
 *
 * jsdom does no layout: every element's `getBoundingClientRect()` here is a
 * zero rect, so the actual pixel claims in the PR body (the count renders at
 * 87px; the last row's bottom sits above the bar's top; the carry banner and
 * the select bar don't overlap) can only be verified against a real browser
 * — that's what the harness run recorded there is for. What this file pins
 * instead, honestly, is what jsdom CAN express completely:
 *
 *  - #267 is pure DOM focus behaviour, not layout — `document.activeElement`
 *    after a click is exactly as real here as in a browser, so it is
 *    asserted directly, not worked around.
 *  - #276's count/width fix is a STATE -> CLASSES mapping (never-truncate on
 *    the count, content-driven bar width) — a regression that reintroduced
 *    `truncate` or a fixed `lg:w-[Nrem]` fails here without a browser.
 *  - The bar's own bottom OFFSET is no longer a class at all — it's an
 *    inline `style.bottom` computed by the shared model, so this reads
 *    `style.bottom` directly (a real DOM property, not a layout
 *    measurement) and compares it against `barOffsetCss` imported from that
 *    same module: an exact-value check, not a substring guess. This file
 *    also pins that entering/leaving select mode actually registers/
 *    unregisters this page's bar in the shared store — the mechanism
 *    root-layout.tsx's `<main>` reserve and the toast layer depend on to
 *    see this page-local state at all (covered from their own side in
 *    use-bottom-stack.test.ts and toast.test.tsx).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, Item } from '@/types/inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCarryStore } from '@/store/carry-store';
import { barOffsetCss } from '@/hooks/use-bottom-stack';
import { useBottomBarStore } from '@/store/bottom-bar-store';
import { ContainerDetail } from './container-detail';

vi.mock('@/components/labels/label-print-dialog', () => ({ LabelPrintDialog: () => null }));
vi.mock('@/components/sharing/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/inventory/entity-form', () => ({ EntityForm: () => null }));
vi.mock('@/components/tags/tag-picker', () => ({ TagPicker: () => null }));
vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));

const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

function makeContainer(over: Partial<Container> & { id: number }): Container {
  return {
    areaId: 5, parentContainerId: null, name: `Bin ${over.id}`, type: 'box',
    description: null, qrCode: `TLY-C-${over.id}`, containerCount: 0, itemCount: 0,
    breadcrumb: [], ...over,
  } as Container;
}

function makeItem(over: Partial<Item> & { id: number }): Item {
  return {
    containerId: 1, productId: null, name: `Item ${over.id}`, description: null,
    quantity: 1, purchasePrice: null, currentValue: null, currentValueIsEstimate: false,
    condition: 'good', completeness: 'complete', qrCode: `TLY-I-${over.id}`,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as Item;
}

const container = {
  ...makeContainer({ id: 1, name: 'The Bin', containerCount: 1, itemCount: 2 }),
  propertyId: 7, propertyName: 'Home', areaName: 'Garage',
} as unknown as Container;
const children: Container[] = [makeContainer({ id: 10, name: 'Nested A' })];
const items: Item[] = [makeItem({ id: 20, name: 'Item A' }), makeItem({ id: 21, name: 'Item B' })];

vi.mock('@/hooks/use-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-inventory')>();
  return {
    ...actual,
    useContainer: () => ({ data: container, isLoading: false, isError: false, refetch: vi.fn() }),
    useContainerChildren: () => ({ data: children, isLoading: false }),
    useItems: () => ({ data: items, isLoading: false }),
    useCreateContainer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteContainer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('@/hooks/use-tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-tags')>();
  return { ...actual, useAddTag: () => ({ mutateAsync: vi.fn(), isPending: false }) };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/container/1']}>
      <Routes>
        <Route path="/container/:containerId" element={<ContainerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The select-mode action bar (same helper shape as container-detail.bulk.test.tsx). */
function selectBar(): HTMLElement {
  return screen.getByText(/^\d+ selected$/).closest('div') as HTMLElement;
}

function resetStores() {
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
  useBottomBarStore.setState({ bars: {} });
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReturnValue('sidebar');
  navigateSpy.mockClear();
  resetStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStores();
});

// ── #267: focus leaves the toggle the instant select mode turns on ────────

test('#267: activating select mode blurs the toggle, so the very next Space is not swallowed by it', () => {
  renderPage();
  const toggle = screen.getByRole('button', { name: 'Select' });
  toggle.focus();
  expect(document.activeElement).toBe(toggle);

  fireEvent.click(toggle);

  // Select mode is genuinely on (the bar is up)...
  expect(screen.getByText('0 selected')).toBeTruthy();
  // ...but the toggle no longer holds focus. A focused <button> treats Space
  // as a click; left focused here, the next "scroll the bin" Space keypress
  // would re-fire this exact onClick and silently empty the selection. This
  // is real jsdom focus tracking, not a layout claim — no browser needed.
  expect(document.activeElement).not.toBe(toggle);
  expect(document.activeElement).toBe(document.body);
});

test('#267: exiting select mode via the same toggle still works, and re-entering blurs it again', () => {
  renderPage();
  const toggle = screen.getByRole('button', { name: 'Select' });

  fireEvent.click(toggle); // enter
  fireEvent.click(screen.getByRole('button', { name: 'Select Item A' }));
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.click(toggle); // exit — the Cancel-equivalent path must be untouched
  expect(screen.queryByText(/selected$/)).toBeNull();

  toggle.focus();
  fireEvent.click(toggle); // enter again
  expect(document.activeElement).not.toBe(toggle);
});

// ── #276: the count can never be squeezed, and the bar is content-sized ───

test('#276: the count is shrink-0/whitespace-nowrap — never flex-1/min-w-0/truncate, which is what starved it to 2px', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  const count = screen.getByText('0 selected');
  expect(count.className).toContain('shrink-0');
  expect(count.className).toContain('whitespace-nowrap');
  expect(count.className).not.toContain('flex-1');
  expect(count.className).not.toContain('min-w-0');
  expect(count.className).not.toContain('truncate');
});

test('#276: the bar has no fixed lg width — it is content-driven with a cap instead', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  const bar = selectBar();
  expect(bar.className).toContain('lg:w-auto');
  expect(bar.className).toContain('lg:max-w-[46rem]');
  // The exact bug: a fixed width like the old `lg:w-[26rem]` starved the
  // count regardless of how much screen space was actually free.
  expect(bar.className).not.toMatch(/lg:w-\[[0-9]/);
});

// ── #276 (last-row clearance) + the carry-banner overlap follow-up ────────
// The bar's own bottom-clearance reserve now lives centrally, in
// root-layout.tsx's <main> (see use-bottom-stack.test.ts) — this file's
// job is the two things that stay local to this page: the bar's OWN
// bottom offset (does it correctly dock above the carry banner?), and that
// selecting registers this page's bar so that central reserve — and the
// toast layer — actually find out about it.

test('the bar registers itself in the shared bottom-bar store while selecting, and unregisters on exit', () => {
  renderPage();
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Select' })); // exit (Cancel-equivalent)
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(0);
});

test('the bar unregisters on unmount too (navigating away mid-select)', () => {
  const { unmount } = renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(1);

  unmount();
  expect(Object.keys(useBottomBarStore.getState().bars)).toHaveLength(0);
});

test('sidebar chrome: the bar\'s own offset matches the shared model, and moves once the carry banner is also showing', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(selectBar().style.bottom).toBe(barOffsetCss({ touch: false, carrying: false }));

  // CarryBanner (root-layout.tsx) renders whenever the store holds a carry —
  // not mocked here, so setting real store state exercises the exact same
  // `carryBannerShowing` (use-bottom-stack.ts) the bar itself reads.
  act(() => { useCarryStore.getState().pickUp([{ id: 99, name: 'Something' }]); });

  // The bar docks higher, to clear the carry banner's own dock, computed by
  // the SAME shared function root-layout.tsx's <main> reserve and
  // carry-banner.tsx's own dock use — not a number re-derived here.
  const carryingOffset = barOffsetCss({ touch: false, carrying: true });
  expect(selectBar().style.bottom).toBe(carryingOffset);
  expect(selectBar().style.bottom).not.toBe(barOffsetCss({ touch: false, carrying: false }));
});

test('the "put back" (lastMove) banner counts as showing too, not just an active carry', () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  act(() => {
    useCarryStore.setState({
      lastMove: { items: [{ id: 1, name: 'Thing' }], to: { id: 2, name: 'Bin', type: 'container' } },
    });
  });

  expect(selectBar().style.bottom).toBe(barOffsetCss({ touch: false, carrying: true }));
});

test('touch chrome: the bar\'s offset makes the same carrying-aware jump, on its own numbers', () => {
  vi.mocked(useLayoutMode).mockReturnValue('touch');
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));

  expect(selectBar().style.bottom).toBe(barOffsetCss({ touch: true, carrying: false }));

  act(() => { useCarryStore.getState().pickUp([{ id: 99, name: 'Something' }]); });

  expect(selectBar().style.bottom).toBe(barOffsetCss({ touch: true, carrying: true }));
  expect(selectBar().style.bottom).not.toBe(barOffsetCss({ touch: true, carrying: false }));
});
