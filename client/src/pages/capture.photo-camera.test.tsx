// @vitest-environment jsdom
/**
 * Driven tests for the capture page's photo-phase fork (#226): step 1 runs the
 * embedded PhotoCamera when getUserMedia exists, and falls back — per mount —
 * to the OS-input button when it does not, when it rejects, or when the user
 * asks for it ("Use system camera").
 *
 * The contract:
 *
 *   (1) with a working getUserMedia, step 1 renders the live preview (no OS
 *       button), and the shutter feeds acceptPhotoFile — the same single
 *       entry point the OS input uses — landing the flow on step 2 with the
 *       PhotoCamera's stream released before the barcode scanner mounts
 *   (2) with getUserMedia missing (jsdom's natural state), the fallback fires
 *       and step 1 renders today's OS-input button wired to the hoisted
 *       `<input capture="environment">`, which still drives the flow
 *   (3) "Use system camera" under the preview swaps THIS mount to the OS
 *       button and releases the stream
 *
 * Mocking follows capture.kill-switch.test.tsx: camera-dependent step-2/3
 * children are stubbed, the page and its network calls are real. PhotoCamera
 * itself is REAL — that fork is the thing under test — with the media plumbing
 * stubbed at the platform layer (getUserMedia, video metadata, canvas.toBlob).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('@/components/inventory/destination-picker', () => ({
  DestinationPicker: ({ onPick }: { onPick: (b: { id: number; name: string; areaId: number }) => void }) => (
    <button type="button" onClick={() => onPick({ id: 42, name: 'Test Bin', areaId: 7 })}>
      mock-pick-bin
    </button>
  ),
}));
vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/products/_y_/identify-photo')) {
      return jsonResponse({ success: true, data: { available: false, matchAvailable: false, suggestion: null } });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(path));
}

type TrackStub = { stop: ReturnType<typeof vi.fn> };

function makeTracks(): TrackStub[] {
  return [{ stop: vi.fn() }];
}

function stubGetUserMedia(tracks: TrackStub[]) {
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => tracks } as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return getUserMedia;
}

function renderCapture(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Capture />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Bring the (stubbed) stream fully up: attached, sized, metadata announced. */
async function streamReady(container: HTMLElement) {
  const video = container.querySelector('video') as HTMLVideoElement;
  expect(video).toBeTruthy();
  await waitFor(() => expect(video.srcObject).toBeTruthy());
  Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });
  fireEvent(video, new Event('loadedmetadata'));
  return video;
}

beforeEach(() => {
  // jsdom naturally has NO navigator.mediaDevices — each test that wants the
  // embedded camera stubs it in explicitly; this reset keeps the order-free.
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not supported in jsdom'))));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('(1) embedded camera renders, and its shutter feeds acceptPhotoFile into step 2', async () => {
  const tracks = makeTracks();
  stubGetUserMedia(tracks);
  const fetchMock = makeFetchMock();
  const { container } = renderCapture(fetchMock);

  // The live preview replaced the OS-input round trip…
  expect(screen.queryByRole('button', { name: /take a photo of the item/i })).toBeNull();
  const video = await streamReady(container);
  expect(video).toBeTruthy();

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
      cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }));
    });

  fireEvent.click(screen.getByRole('button', { name: /take photo/i }));

  // …and the shot went through the ONE photo entry point: draft holds the
  // photo, the flow advanced to step 2, identification fired.
  await screen.findByPlaceholderText('Name it, or search…');
  expect(screen.getByText(/photo held/i)).toBeTruthy();
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(1));

  // One camera at a time: PhotoCamera is unmounted and released before the
  // (mocked) barcode scanner phase renders.
  expect(container.querySelector('video')).toBeNull();
  tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  expect(screen.getByTestId('product-scanner')).toBeTruthy();
});

test('(2) no getUserMedia: the OS-input button renders, wired to the hoisted capture input', async () => {
  const fetchMock = makeFetchMock();
  const { container } = renderCapture(fetchMock);

  // Fallback fired on mount — today's button is back and no preview exists.
  const osButton = await screen.findByRole('button', { name: /take a photo of the item/i });
  expect(container.querySelector('video')).toBeNull();

  // Same handler as ever: the button clicks the hoisted OS-camera input…
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  expect(fileInput.getAttribute('capture')).toBe('environment');
  const click = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
  fireEvent.click(osButton);
  expect(click).toHaveBeenCalledTimes(1);

  // …and a file arriving through that input still drives the flow.
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [photo] } });
  await screen.findByPlaceholderText('Name it, or search…');
  await waitFor(() => expect(callsTo(fetchMock, '/api/products/_y_/identify-photo')).toHaveLength(1));
});

test('(3) "Use system camera" swaps this mount to the OS button and releases the stream', async () => {
  const tracks = makeTracks();
  stubGetUserMedia(tracks);
  const fetchMock = makeFetchMock();
  const { container } = renderCapture(fetchMock);
  await streamReady(container);

  fireEvent.click(screen.getByRole('button', { name: /use system camera/i }));

  expect(await screen.findByRole('button', { name: /take a photo of the item/i })).toBeTruthy();
  expect(container.querySelector('video')).toBeNull();
  tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
});
