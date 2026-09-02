/**
 * What a photo becomes before it is sent.
 *
 * Every upload route on the server takes jpeg/png/webp (files also takes gif
 * and documents) and rejects the rest with a 415. On iOS `accept="image/*"`
 * hands the browser a HEIC, so a photo picked on an item page went straight
 * to that 415 — a 500, before #346 — while capture had quietly solved it with
 * a canvas re-encode. This is that solution, shared, so the three photo paths
 * (capture, item page, condition form) cannot drift on it again.
 */

/** The types every server upload route accepts. */
export const SENDABLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Downscale to keep uploads small on garage wifi (and dodge the 20MB cap). */
export async function downscale(file: File, max = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1_500_000) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.82),
  );
}

/**
 * Re-encode to jpeg when the type is not one the routes take. downscale() has
 * three paths that hand back the ORIGINAL untouched — bitmap decode failure,
 * the small-image passthrough, and toBlob returning null — so a blob leaving
 * it is not reliably a jpeg. If the bitmap will not decode either, the
 * original goes as-is and the server says why (415).
 */
export async function asSendableImage(blob: Blob): Promise<Blob> {
  if ((SENDABLE_TYPES as readonly string[]).includes(blob.type)) return blob;
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return blob;
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.82),
  );
}

/** The extension that matches an image type — the server sniffs bytes, so the
 *  name and the declared type have to tell the same story as the content. */
export function extFor(type: string): 'jpg' | 'png' | 'webp' {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Downscaled, in a type the server accepts, named to match. The File comes
 * back identical when nothing needed doing, so callers can keep the user's
 * own name when it was already fine.
 */
export async function prepareImage(file: File, max = 1600): Promise<File> {
  const blob = await asSendableImage(await downscale(file, max));
  if (blob === file) return file;
  const type = blob.type || 'image/jpeg';
  const stem = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${stem}.${extFor(type)}`, { type });
}
