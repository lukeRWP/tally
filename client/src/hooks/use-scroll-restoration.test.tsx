// @vitest-environment jsdom
/**
 * Scroll position lost on every back-navigation (#232) — root-layout's main
 * container unconditionally reset `scrollTop` to 0 on every pathname change,
 * so item 30 of a scrolled list -> detail -> Back always landed at the top.
 *
 * Contract under test (task-1 brief):
 *   (a) PUSH to a new path scrolls the container to 0.
 *   (b) scrolling to 480, PUSHing away, then POPping back restores 480.
 *   (c) the cache survives a remount via sessionStorage (module state is
 *       lost, e.g. on reload; sessionStorage is not).
 *   (d) PUSH clears the destination path's stale cached entry, so a later
 *       POP to that path doesn't resurrect a scroll offset from long ago.
 *
 * The hook is re-imported fresh (via `vi.resetModules()` + dynamic import)
 * in every test, since its cache is a deliberate module-level singleton
 * (brief step 2) — isolating tests this way is what lets test (c) actually
 * exercise the sessionStorage fallback instead of coasting on in-memory
 * state left behind by a previous test.
 *
 * `requestAnimationFrame`/`cancelAnimationFrame` don't exist in jsdom, so
 * both are stubbed with a queue the test flushes explicitly — this also
 * verifies restoration genuinely waits a frame rather than writing
 * `scrollTop` synchronously.
 */
import * as React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useScrollRestoration as UseScrollRestoration } from './use-scroll-restoration';

const STORAGE_KEY = 'tally-scroll-cache';

function installRafMock() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pending.delete(id);
  });
  return {
    /** Runs every callback currently queued, one simulated frame. */
    flush() {
      const due = Array.from(pending.values());
      pending.clear();
      due.forEach((cb) => cb(0));
    },
  };
}

function scrollTo(el: HTMLElement, value: number) {
  el.scrollTop = value;
  el.dispatchEvent(new Event('scroll'));
}

/** Fresh module instance so the module-level cache Map starts unhydrated. */
async function freshHook(): Promise<typeof UseScrollRestoration> {
  vi.resetModules();
  const mod = await import('./use-scroll-restoration');
  return mod.useScrollRestoration;
}

/**
 * Mirrors root-layout's real shape closely enough to matter: a single
 * persistent container element that survives across route changes (a
 * catch-all Route re-renders this same component for every pathname,
 * exactly as root-layout's <main> is outside the <Outlet/> that swaps),
 * with the hook wired to its ref.
 */
function makeHarness(useHook: typeof UseScrollRestoration) {
  return function Harness({ mainRef }: { mainRef: React.RefObject<HTMLDivElement | null> }) {
    useHook(mainRef);
    const navigate = useNavigate();
    return (
      <div>
        <button onClick={() => navigate('/list')}>to-list</button>
        <button onClick={() => navigate('/detail')}>to-detail</button>
        <button onClick={() => navigate('/other')}>to-other</button>
        <button onClick={() => navigate(-1)}>back</button>
        {/* Mirrors Home's debounced search (#224): same pathname, different
            search params, replace:true — a real REPLACE, not a mock. */}
        <button onClick={() => navigate('/list?q=xyz', { replace: true })}>replace-list-search</button>
        <div ref={mainRef as React.RefObject<HTMLDivElement>} data-testid="container" />
      </div>
    );
  };
}

function renderHarness(useHook: typeof UseScrollRestoration, initialEntries: string[] = ['/list']) {
  const mainRef = React.createRef<HTMLDivElement>();
  const Harness = makeHarness(useHook);
  const utils = render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="*" element={<Harness mainRef={mainRef} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, mainRef };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useScrollRestoration', () => {
  it('(a) PUSH to a new path scrolls the container to 0', async () => {
    const raf = installRafMock();
    const useHook = await freshHook();
    const { getByText, mainRef } = renderHarness(useHook, ['/list']);
    const el = mainRef.current!;

    el.scrollTop = 250;
    expect(el.scrollTop).toBe(250);

    fireEvent.click(getByText('to-detail'));
    raf.flush();

    expect(el.scrollTop).toBe(0);
  });

  it('(b) scrolling to 480, PUSHing away, then POPping back restores 480', async () => {
    const raf = installRafMock();
    const useHook = await freshHook();
    const { getByText, mainRef } = renderHarness(useHook, ['/list']);
    const el = mainRef.current!;

    scrollTo(el, 480);
    raf.flush(); // the rAF-throttled listener records 480 against '/list'

    fireEvent.click(getByText('to-detail')); // PUSH away
    raf.flush();
    expect(el.scrollTop).toBe(0); // fresh page, top

    fireEvent.click(getByText('back')); // POP back to '/list'
    raf.flush(); // restore is scheduled via rAF, not synchronous

    expect(el.scrollTop).toBe(480);
  });

  it('(c) the cache survives a remount via sessionStorage', async () => {
    const raf = installRafMock();
    const useHookA = await freshHook();
    const first = renderHarness(useHookA, ['/list']);

    scrollTo(first.mainRef.current!, 480);
    raf.flush();

    // Leaving '/list' persists the in-memory cache to sessionStorage.
    fireEvent.click(first.getByText('to-detail'));
    raf.flush();
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ '/list': 480 });

    first.unmount();

    // Simulate a fresh module instance (e.g. a reload) landing back on
    // '/list' via POP — its own in-memory Map starts empty and must
    // rehydrate from sessionStorage, not from anything test A left behind.
    const useHookB = await freshHook();
    const second = renderHarness(useHookB, ['/list']);
    raf.flush();

    expect(second.mainRef.current!.scrollTop).toBe(480);
  });

  it("(d) PUSH clears the destination path's stale cached entry", async () => {
    // A leftover offset from long ago, seeded directly into sessionStorage
    // before the hook ever runs.
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ '/detail': 999 }));

    const raf = installRafMock();
    const useHook = await freshHook();
    const { getByText, mainRef } = renderHarness(useHook, ['/list']);
    const el = mainRef.current!;

    // Mounting on '/list' (POP, the initial history action) hydrates the
    // cache from sessionStorage into memory — '/detail': 999 is now loaded.
    raf.flush();

    fireEvent.click(getByText('to-detail')); // PUSH, not POP
    raf.flush();

    // The stale 999 must never be applied...
    expect(el.scrollTop).toBe(0);

    // ...and must actually be gone from the cache, not just skipped this
    // once: leaving '/detail' (nothing scrolled there) persists whatever
    // remains, which must no longer include '/detail'.
    fireEvent.click(getByText('to-other'));
    raf.flush();

    const persisted = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted).not.toHaveProperty('/detail');
  });

  it('(f) a container that mounts AFTER the first render (auth-gated cold load) still gets tracked and restored', async () => {
    // Root-layout's real shape on a cold load: the first render is a loading
    // gate with NO <main> at all; the container appears on a later render.
    // ref.current is not reactive, so without the element-mirroring state the
    // hook ran once against null and the session's first pathname was never
    // tracked — scroll deep, open an item, Back landed at top (wave-3 driven
    // pass, #232).
    const raf = installRafMock();
    const useHook = await freshHook();
    const mainRef = React.createRef<HTMLDivElement>();
    let setLoaded: (v: boolean) => void = () => {};

    function GatedHarness() {
      useHook(mainRef);
      const [loaded, set] = React.useState(false);
      setLoaded = set;
      const navigate = useNavigate();
      return (
        <div>
          <button onClick={() => navigate('/detail')}>to-detail</button>
          <button onClick={() => navigate(-1)}>back</button>
          {loaded && <div ref={mainRef} data-testid="container" />}
        </div>
      );
    }

    const { getByText } = render(
      <MemoryRouter initialEntries={['/list']}>
        <Routes>
          <Route path="*" element={<GatedHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    // The auth gate resolves: <main> mounts on a later render, same pathname.
    act(() => setLoaded(true));
    const el = mainRef.current!;

    scrollTo(el, 480);
    raf.flush(); // the throttled listener must be live despite the late mount

    fireEvent.click(getByText('to-detail')); // PUSH away persists the cache
    raf.flush();
    expect(el.scrollTop).toBe(0);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ '/list': 480 });

    fireEvent.click(getByText('back')); // POP back restores
    raf.flush();
    expect(el.scrollTop).toBe(480);
  });

  it('(e) a same-pathname REPLACE (Home\'s debounced search, #224) is a full no-op', async () => {
    const raf = installRafMock();
    const useHook = await freshHook();
    const { getByText, mainRef } = renderHarness(useHook, ['/list']);
    const el = mainRef.current!;

    scrollTo(el, 300); // recorded into the cache for '/list'
    raf.flush();

    // A bit more scroll since that last throttled flush, deliberately NOT
    // dispatched as a 'scroll' event — this leaves the cache at 300 while
    // the live DOM sits at 305, so the three possible (wrong) behaviours
    // are each distinguishable from "left alone": reset would show 0,
    // a spurious restore-from-cache would show 300, only "untouched" shows
    // 305.
    el.scrollTop = 305;

    // REPLACE, same pathname, only the search params differ — exactly
    // Home's debounced-search navigation (#224).
    fireEvent.click(getByText('replace-list-search'));
    raf.flush();

    // (a) scrollTop untouched — no reset to 0.
    expect(el.scrollTop).toBe(305);

    // (c) no restore write happened either: had one been scheduled, flushing
    // the rAF queue above would have overwritten 305 with the cached 300.
    // (Verified together with (a) since they'd produce the same wrong value.)

    // (b) the cached entry for '/list' was not cleared — force a persist
    // (route-leave normally does this; pagehide is the other trigger) and
    // check sessionStorage still holds the original 300, not deleted and
    // not clobbered by the untouched live 305.
    window.dispatchEvent(new Event('pagehide'));
    const persisted = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted['/list']).toBe(300);
  });
});
