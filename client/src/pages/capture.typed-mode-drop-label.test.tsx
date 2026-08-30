// @vitest-environment jsdom
/**
 * #284 — typed mode advertised drag-and-drop to a device that cannot drag
 * files. The photo panel read "drop one here, or choose a file" with
 * `onDragOver`/`onDrop` wired up, unconditionally — including on a landscape
 * tablet that switched to "Type it instead" (a COARSE pointer), where half
 * that label names a gesture the device physically cannot perform. The tap
 * half of the sentence, and the handlers themselves, are untouched: only the
 * label forks on `useCoarsePointer()`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { SIDEBAR_QUERY } from '@/hooks/use-layout-mode';
import { COARSE_QUERY } from '@/hooks/use-coarse-pointer';
import { Capture } from './capture';

vi.mock('@/components/scanner/product-scanner', () => ({
  ProductScanner: () => <div data-testid="product-scanner">barcode scanner</div>,
}));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner">tag scanner</div>,
}));
vi.mock('@/components/scanner/product-search', () => ({
  ProductSearch: () => <div data-testid="product-search" />,
}));
vi.mock('@/components/scanner/url-extractor', () => ({
  UrlExtractor: () => <div data-testid="url-extractor" />,
}));

/** A matchMedia stub reporting an arbitrary set of queries as matching. */
function stubMedia(matching: string[]) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matching.includes(query), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
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
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a fine-pointer desk keeps the drag-and-drop wording', () => {
  // Desk (sidebar), fine pointer — the form shows directly, no tablet switch.
  stubMedia([SIDEBAR_QUERY]);
  renderCapture();

  expect(screen.getByRole('button', { name: /drop one here, or choose a file/i })).toBeTruthy();
  expect(screen.queryByText('choose a photo')).toBeNull();
});

test('a landscape tablet ("Type it instead") gets tap-only wording, not drag-and-drop', () => {
  // Desk-shaped layout AND a coarse (finger) pointer — the tablet case.
  stubMedia([SIDEBAR_QUERY, COARSE_QUERY]);
  renderCapture();

  fireEvent.click(screen.getByRole('button', { name: /type it instead/i }));

  expect(screen.getByText('choose a photo')).toBeTruthy();
  expect(screen.queryByText(/drop one here/i)).toBeNull();
});
