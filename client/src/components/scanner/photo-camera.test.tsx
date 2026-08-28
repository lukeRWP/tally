// @vitest-environment jsdom
/**
 * Driven tests for PhotoCamera (#226) — the capture flow's step-1 embedded
 * camera. The contract under test (task brief step 1):
 *
 *   (a) getUserMedia resolves → the video mounts, and a shutter click produces
 *       a JPEG File handed to onCapture (canvas at videoWidth×videoHeight,
 *       toBlob('image/jpeg', 0.85), File named 'capture.jpg')
 *   (b) getUserMedia rejecting — or being absent entirely — fires onFallback
 *   (c) stream tracks are stopped on unmount and on visibilitychange hidden,
 *       and hidden→visible re-acquires a fresh stream
 *   (d) the "Use system camera" link calls onFallback
 *
 * Plus the lifecycle rule this codebase got burned on: a StrictMode
 * double-mount must end with exactly ONE live stream — the first effect's
 * cleanup stops the stream its own acquire produces, and the second mount
 * acquires again cleanly.
 *
 * jsdom has no real getUserMedia, video pipeline, or canvas encoder, so all
 * three are stubbed: getUserMedia resolves a stub MediaStream whose tracks
 * carry stop spies, video dimensions are defined by hand before dispatching
 * loadedmetadata, and canvas.toBlob calls back synchronously with a Blob.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhotoCamera } from './photo-camera';

type TrackStub = { stop: ReturnType<typeof vi.fn> };

function makeTrack(): TrackStub {
  return { stop: vi.fn() };
}

function makeStream(tracks: TrackStub[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function stubMediaDevices(getUserMedia: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: getUserMedia ? { getUserMedia } : undefined,
    configurable: true,
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

/** Give the video real-looking stream dimensions, then announce them. */
function announceMetadata(video: HTMLVideoElement, w = 640, h = 480) {
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true });
  fireEvent(video, new Event('loadedmetadata'));
}

beforeEach(() => {
  stubMediaDevices(undefined);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  // jsdom's play() is a loud not-implemented stub; the component calls it
  // defensively alongside autoPlay, so quiet it down.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('(a) stream up → shutter draws the frame and hands a JPEG File to onCapture', async () => {
  const tracks = [makeTrack()];
  const getUserMedia = vi.fn().mockResolvedValue(makeStream(tracks));
  stubMediaDevices(getUserMedia);
  const onCapture = vi.fn();
  const onFallback = vi.fn();
  const { container } = render(<PhotoCamera onCapture={onCapture} onFallback={onFallback} />);

  const video = container.querySelector('video') as HTMLVideoElement;
  expect(video).toBeTruthy();
  await waitFor(() => expect(video.srcObject).toBeTruthy());
  expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } });

  // Stream attached but no dimensions yet — the shutter must stay disabled
  // until loadedmetadata proves the video has real frames to draw.
  const shutter = screen.getByRole('button', { name: /take photo/i }) as HTMLButtonElement;
  expect(shutter.disabled).toBe(true);

  announceMetadata(video, 640, 480);
  expect(shutter.disabled).toBe(false);

  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    });

  fireEvent.click(shutter);

  // Canvas sized to the STREAM's dimensions and encoded at the spec'd quality.
  expect(toBlob).toHaveBeenCalledTimes(1);
  expect(toBlob.mock.calls[0][1]).toBe('image/jpeg');
  expect(toBlob.mock.calls[0][2]).toBe(0.85);
  const canvas = toBlob.mock.instances[0] as HTMLCanvasElement;
  expect(canvas.width).toBe(640);
  expect(canvas.height).toBe(480);
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 480);

  expect(onCapture).toHaveBeenCalledTimes(1);
  const file = onCapture.mock.calls[0][0] as File;
  expect(file).toBeInstanceOf(File);
  expect(file.name).toBe('capture.jpg');
  expect(file.type).toBe('image/jpeg');
  expect(onFallback).not.toHaveBeenCalled();
});

test('(b) getUserMedia rejecting fires onFallback', async () => {
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  stubMediaDevices(getUserMedia);
  const onFallback = vi.fn();
  render(<PhotoCamera onCapture={vi.fn()} onFallback={onFallback} />);
  await waitFor(() => expect(onFallback).toHaveBeenCalled());
});

test('(b) getUserMedia missing entirely fires onFallback', () => {
  stubMediaDevices(undefined);
  const onFallback = vi.fn();
  render(<PhotoCamera onCapture={vi.fn()} onFallback={onFallback} />);
  expect(onFallback).toHaveBeenCalled();
});

test('(c) every track stops on unmount', async () => {
  const tracks = [makeTrack(), makeTrack()];
  const getUserMedia = vi.fn().mockResolvedValue(makeStream(tracks));
  stubMediaDevices(getUserMedia);
  const { container, unmount } = render(<PhotoCamera onCapture={vi.fn()} onFallback={vi.fn()} />);
  await waitFor(() => expect((container.querySelector('video') as HTMLVideoElement).srcObject).toBeTruthy());

  unmount();

  tracks.forEach((t) => expect(t.stop).toHaveBeenCalledTimes(1));
});

test('(c) hidden releases the stream; visible re-acquires a fresh one', async () => {
  const first = [makeTrack()];
  const second = [makeTrack()];
  const getUserMedia = vi.fn()
    .mockResolvedValueOnce(makeStream(first))
    .mockResolvedValueOnce(makeStream(second));
  stubMediaDevices(getUserMedia);
  const { container } = render(<PhotoCamera onCapture={vi.fn()} onFallback={vi.fn()} />);
  const video = container.querySelector('video') as HTMLVideoElement;
  await waitFor(() => expect(video.srcObject).toBeTruthy());

  setVisibility('hidden');
  expect(first[0].stop).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();

  setVisibility('visible');
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(video.srcObject).toBeTruthy());
  expect(second[0].stop).not.toHaveBeenCalled();
});

test('(d) the "Use system camera" link calls onFallback', async () => {
  const getUserMedia = vi.fn().mockResolvedValue(makeStream([makeTrack()]));
  stubMediaDevices(getUserMedia);
  const onFallback = vi.fn();
  render(<PhotoCamera onCapture={vi.fn()} onFallback={onFallback} />);

  fireEvent.click(screen.getByRole('button', { name: /use system camera/i }));
  expect(onFallback).toHaveBeenCalledTimes(1);
});

test('StrictMode double-mount ends with exactly one live stream', async () => {
  const streams: TrackStub[][] = [];
  const getUserMedia = vi.fn().mockImplementation(async () => {
    const tracks = [makeTrack()];
    streams.push(tracks);
    return makeStream(tracks);
  });
  stubMediaDevices(getUserMedia);
  render(
    <React.StrictMode>
      <PhotoCamera onCapture={vi.fn()} onFallback={vi.fn()} />
    </React.StrictMode>,
  );

  // Dev StrictMode runs mount → cleanup → mount: two acquires…
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  // …but the first effect's cleanup already cancelled its acquire, so its
  // stream is stopped the moment it resolves, and only the second survives.
  await waitFor(() => {
    const live = streams.filter((tracks) => tracks.every((t) => t.stop.mock.calls.length === 0));
    expect(live).toHaveLength(1);
  });
  expect(streams).toHaveLength(2);
  expect(streams[0][0].stop).toHaveBeenCalled();
});
