import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Returns `url` only if it is a safe http(s) external link, else `undefined`.
 * External product-lookup APIs are untrusted, so a `javascript:`/`data:` URL
 * could otherwise reach an anchor's href and execute in-origin on click.
 * Use as `href={safeExternalUrl(link.url)}` — a rejected URL yields an
 * unclickable anchor rather than a script vector.
 */
export function safeExternalUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
