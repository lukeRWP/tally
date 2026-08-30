// @vitest-environment jsdom
/**
 * The scanner's `Close` is never handed to a finger (#268), on every page
 * that mounts a scanner.
 *
 * Capture fixed this first: `Stop` pauses the decode loop and is one tap to
 * undo, while `Close` leaves — and the two are identical 32px controls 8px
 * apart inside the scanner's own control row, which is the classic
 * coarse-pointer mis-tap. The other two scanner surfaces shipped the same
 * pair: `/scan` leaves the page, `/move` abandons the load being gathered or
 * ends a distribute session that has a full-size Done button of its own.
 *
 * `onClose` is optional on CameraScanner and its wrappers, so "not handed to
 * a finger" is literally the prop being absent — which is what these assert.
 * A mouse still gets the button: a cursor does not slip 8px.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';
import { useCarryStore } from '@/store/carry-store';
import { Scan } from './scan';
import { PutDown } from './put-down';

/** Every TagScanner mount's props — the prop IS the contract here. */
const { tagScannerProps } = vi.hoisted(() => ({
  tagScannerProps: [] as { onClose?: () => void }[],
}));

vi.mock('@/hooks/use-layout-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-layout-mode')>();
  return { ...actual, useLayoutMode: vi.fn() };
});
vi.mock('@/hooks/use-coarse-pointer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-coarse-pointer')>();
  return { ...actual, useCoarsePointer: vi.fn() };
});
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: (props: { onClose?: () => void }) => {
    tagScannerProps.push(props);
    return <div data-testid="tag-scanner">tag scanner</div>;
  },
}));
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: () => <div data-testid="destination-picker" />,
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setMode(layout: 'sidebar' | 'touch', coarse: boolean) {
  vi.mocked(useLayoutMode).mockReturnValue(layout);
  vi.mocked(useCoarsePointer).mockReturnValue(coarse);
}

function renderPage(page: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tagScannerProps.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, data: {} })));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCarryStore.setState({ carried: [], lastMove: null, pinnedDest: null, lastDest: null });
});

test('/scan on a phone: the scanner renders with no Close', () => {
  setMode('touch', true);
  renderPage(<Scan />);

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  expect(tagScannerProps.every((p) => p.onClose === undefined)).toBe(true);
});

test('/scan on a coarse-pointer tablet: same — the sidebar does not make it a mouse', () => {
  setMode('sidebar', true);
  renderPage(<Scan />);

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  expect(tagScannerProps.every((p) => p.onClose === undefined)).toBe(true);
});

test('/scan with a fine pointer keeps Close — the hazard is the finger, not the control', () => {
  // A narrow window with a mouse: no sidebar chrome, so the camera layout
  // renders, but the pointer is a cursor.
  setMode('touch', false);
  renderPage(<Scan />);

  expect(tagScannerProps.length).toBeGreaterThan(0);
  expect(tagScannerProps.every((p) => typeof p.onClose === 'function')).toBe(true);
});

test('/move gather on a finger: no Close beside Stop while a load is being carried', () => {
  setMode('touch', true);
  useCarryStore.setState({
    carried: [{ id: 1, name: 'Widget A', kind: 'item' as const }],
    lastMove: null, pinnedDest: null, lastDest: null,
  });
  renderPage(<PutDown />);

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  expect(tagScannerProps.every((p) => p.onClose === undefined)).toBe(true);
});

test('/move distribute on a finger: no Close either — Done is a full-size button of its own', () => {
  setMode('touch', true);
  useCarryStore.setState({
    carried: [],
    lastMove: null,
    pinnedDest: { id: 50, name: 'Bin C', type: 'container' },
    lastDest: null,
  });
  renderPage(<PutDown />);

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  expect(tagScannerProps.every((p) => p.onClose === undefined)).toBe(true);
  // The action itself is not lost — it is the banner's own control.
  expect(screen.getByRole('button', { name: /^done$/i })).toBeTruthy();
});

test('/move with a fine pointer keeps Close', () => {
  setMode('touch', false);
  useCarryStore.setState({
    carried: [{ id: 1, name: 'Widget A', kind: 'item' as const }],
    lastMove: null, pinnedDest: null, lastDest: null,
  });
  renderPage(<PutDown />);

  expect(tagScannerProps.length).toBeGreaterThan(0);
  expect(tagScannerProps.every((p) => typeof p.onClose === 'function')).toBe(true);
});
