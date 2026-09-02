import { afterEach, describe, expect, it, vi } from 'vitest';
import { extFor, prepareImage, SENDABLE_TYPES } from './image';

// #346 — the three photo paths share this now. jsdom has no bitmap decoder or
// canvas encoder, so the canvas legs are exercised in the browser; what is
// pinned here is the contract around them: what passes through untouched,
// what the server is told about a re-encoded file, and that a photo the
// browser cannot decode is handed on as-is for the server to name the reason.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extFor', () => {
  it('names the file for the bytes the server will sniff', () => {
    expect(extFor('image/png')).toBe('png');
    expect(extFor('image/webp')).toBe('webp');
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('')).toBe('jpg');
  });
});

describe('prepareImage', () => {
  it('returns a small, sendable photo untouched — the user keeps their own name', async () => {
    // A bitmap that needs no scaling and a file under the size floor: the
    // downscale passthrough. Its type is already one the routes take, so
    // asSendableImage passes it through too.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600 })));
    const file = new File([new Uint8Array(1024)], 'shelf.png', { type: 'image/png' });
    expect(await prepareImage(file)).toBe(file);
  });

  it('hands an undecodable photo on as-is, so the server says why', async () => {
    // The iOS HEIC on a browser that cannot decode it. Nothing here can turn
    // it into a jpeg; the honest move is to send it and let the 415 speak.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('no decoder'); }));
    const file = new File([new Uint8Array(1024)], 'IMG_0001.heic', { type: 'image/heic' });
    expect(await prepareImage(file)).toBe(file);
  });

  it('accepts exactly what every upload route accepts', () => {
    // vision.http.js ACCEPTED, and a subset of files.routes.js ALLOWED_MIMES —
    // one prepared file has to be good for all three routes.
    expect([...SENDABLE_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});
