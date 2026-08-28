import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Root-layout's scroll container is not the window (main-container is
 * `overflow-y-auto`), so browser-native scroll restoration never sees it —
 * every back-navigation landed at the top of whatever list you'd scrolled 30
 * items into (#232). This hook replaces root-layout's unconditional
 * `scrollTo(0, 0)` on pathname change with POP-aware restore/reset.
 *
 * Keyed on PATHNAME, not the full location. Home's URL-synced search (#224)
 * writes `{ replace: true }` on every debounced keystroke — a REPLACE whose
 * pathname didn't change (only `?q=` moved) must leave scroll exactly where
 * it is, or every keystroke would look like a fresh page and reset it.
 * REPLACE only behaves like PUSH (reset to top) when the pathname itself
 * changed.
 */

const STORAGE_KEY = 'tally-scroll-cache';

function loadCache(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(parsed));
    }
  } catch {
    /* private window or unavailable — in-memory Map still works for this session */
  }
  return new Map();
}

// Module-level: the cache must outlive a single hook instance (root-layout
// itself never unmounts, but a fresh module instance — e.g. after
// `vi.resetModules()`, or conceptually a full page reload — re-hydrates
// lazily from sessionStorage on first access rather than starting empty.
let scrollCache: Map<string, number> | null = null;

function getCache(): Map<string, number> {
  if (!scrollCache) scrollCache = loadCache();
  return scrollCache;
}

function persistCache() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(getCache())));
  } catch {
    /* private window or quota — the in-memory Map still works for the rest of this session */
  }
}

export function useScrollRestoration(ref: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  // Null on first mount so the very first pathname is treated as "changed"
  // (there is nothing to leave scroll alone for yet) without special-casing it.
  const prevPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const pathnameChanged = prevPathnameRef.current !== pathname;
    prevPathnameRef.current = pathname;

    if (pathnameChanged) {
      if (navigationType === 'POP') {
        const cached = getCache().get(pathname);
        if (cached != null) {
          // Best-effort, one frame: list content mounted by this same
          // navigation may still be loading (React Query cache misses), so
          // give layout one paint to catch up before restoring. If the
          // content ends up shorter than `cached`, the browser clamps — no
          // retry/observer machinery per spec.
          requestAnimationFrame(() => {
            if (ref.current) ref.current.scrollTop = cached;
          });
        }
      } else {
        // PUSH, or REPLACE that actually changed the page: a fresh page
        // starts at the top, and any stale offset cached for it (e.g. a
        // pathname visited long ago) must not leak into this visit.
        el.scrollTop = 0;
        getCache().delete(pathname);
      }
    }
    // else: REPLACE with only search params changed (Home's debounced
    // search, #224) — leave scroll exactly where it is.

    // rAF-throttled write: records against `pathname`, captured fresh in this
    // closure and re-registered every time pathname changes, so a listener
    // still flushing from the page just left can never record under the new
    // page's key.
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      getCache().set(pathname, el.scrollTop);
    };
    const onScroll = () => {
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', persistCache);

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', persistCache);
      if (rafId != null) cancelAnimationFrame(rafId);
      // Route-leave persistence — the in-memory Map is already accurate
      // (updated continuously by the scroll listener above); this just
      // flushes it to sessionStorage so a reload doesn't lose it.
      persistCache();
    };
  }, [pathname, navigationType, ref]);
}
