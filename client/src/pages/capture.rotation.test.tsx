// @vitest-environment jsdom
/**
 * #280 — rotating a tablet must not take the typed form away mid-entry.
 *
 * `showForm` was `atDesk && (!coarse || typedMode)`, and the `atDesk` half was
 * quietly doing two jobs: "a mouse desk gets the form", and "the form only
 * exists in landscape". Only the first was intended. A landscape iPad told
 * "Type it instead", half-way through naming an item, answered a rotation to
 * portrait by throwing the form away and starting a live camera —
 * `typedMode` survived (Capture does not remount) but the surface it selects
 * did not, and portrait offered no control anywhere to get back.
 *
 * The draft itself was never destroyed, which is why this was a P2 and not a
 * P1; the test below pins BOTH halves — the values survive AND the form they
 * were being typed into stays on screen.
 *
 * Written against the hooks rather than matchMedia because a rotation is
 * exactly a change in what useLayoutMode returns, and re-mocking one return
 * value between renders is the cleanest way to say that.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';
import { Capture } from './capture';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/hooks/use-coarse-pointer', () => ({ useCoarsePointer: vi.fn() }));
vi.mock('@/components/scanner/product-scanner', () => ({
  ProductScanner: () => <div data-testid="product-scanner" />,
}));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner" />,
}));
vi.mock('@/components/scanner/photo-camera', () => ({
  PhotoCamera: () => <div data-testid="photo-camera" />,
}));
vi.mock('@/components/scanner/product-search', () => ({ ProductSearch: () => <div /> }));
vi.mock('@/components/scanner/url-extractor', () => ({ UrlExtractor: () => <div /> }));
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

/** landscape tablet = sidebar chrome + a finger; portrait tablet = touch chrome + a finger. */
function setSurface(layout: 'sidebar' | 'touch', coarse: boolean) {
  vi.mocked(useLayoutMode).mockReturnValue(layout);
  vi.mocked(useCoarsePointer).mockReturnValue(coarse);
}

function renderCapture() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReset();
  vi.mocked(useCoarsePointer).mockReset();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, data: {} })));
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a half-typed draft keeps its FORM, not just its values, across a rotation to portrait', async () => {
  setSurface('sidebar', true);
  const { rerender } = renderCapture();

  fireEvent.click(screen.getByRole('button', { name: /type it instead/i }));
  const name = await screen.findByLabelText(/what is it/i);
  fireEvent.change(name, { target: { value: 'Half typed item' } });

  // Rotate. Capture does not remount, so typedMode survives — the point is
  // that the form it selects now survives with it.
  setSurface('touch', true);
  rerender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Capture /></MemoryRouter>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText(/what is it/i)).toBeTruthy());
  expect((screen.getByLabelText(/what is it/i) as HTMLInputElement).value).toBe('Half typed item');
  // …and no camera was started underneath it.
  expect(screen.queryByTestId('photo-camera')).toBeNull();
});

test('the way back to the camera survives the rotation too — portrait is not a one-way trip', async () => {
  setSurface('sidebar', true);
  const { rerender } = renderCapture();
  fireEvent.click(screen.getByRole('button', { name: /type it instead/i }));
  await screen.findByLabelText(/what is it/i);

  setSurface('touch', true);
  rerender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Capture /></MemoryRouter>
    </QueryClientProvider>,
  );

  const useCamera = await screen.findByRole('button', { name: /use camera/i });
  fireEvent.click(useCamera);
  await waitFor(() => expect(screen.getByTestId('photo-camera')).toBeTruthy());
  expect(screen.queryByLabelText(/what is it/i)).toBeNull();
});

test('a phone is untouched: no typed form, and no switch to reach one', () => {
  setSurface('touch', true);
  renderCapture();

  expect(screen.getByTestId('photo-camera')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /type it instead/i })).toBeNull();
  expect(screen.queryByLabelText(/what is it/i)).toBeNull();
});

test('a fine-pointer desk still opens straight into the form (regression pin)', () => {
  setSurface('sidebar', false);
  renderCapture();

  expect(screen.getByLabelText(/what is it/i)).toBeTruthy();
  expect(screen.queryByTestId('photo-camera')).toBeNull();
  // Nothing to switch back TO on a machine with no rear camera.
  expect(screen.queryByRole('button', { name: /use camera/i })).toBeNull();
});

test('a portrait tablet still COLD-OPENS camera-first — carried devices lead with the camera', () => {
  setSurface('touch', true);
  renderCapture();
  expect(screen.getByTestId('photo-camera')).toBeTruthy();
  expect(screen.queryByLabelText(/what is it/i)).toBeNull();
});
