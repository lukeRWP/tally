import { create } from 'zustand';

/**
 * Registry of page-local fixed-bottom action bars (today: only the
 * select-mode bulk bar on container-detail and recycle-bin-list) that are
 * currently on screen.
 *
 * This exists because global chrome mounted once at the app root — the toast
 * layer, `<main>`'s own scroll reserve in root-layout.tsx — cannot otherwise
 * see a page's local `selecting` state to know it needs extra bottom
 * clearance. A page registers while its bar is up (see
 * `useRegisterBottomBar` in `hooks/use-bottom-stack.ts`, which wraps this in
 * a mount-effect so callers never touch this store directly) and
 * unregisters the moment it goes away or the page unmounts.
 *
 * Keyed by an arbitrary id rather than a lone boolean: exactly one route is
 * ever mounted at a time today, so there is only ever one registrant in
 * practice, but keying means a stray double-registration (or a future
 * second bar-bearing page) can't have one's cleanup silently clobber the
 * other's.
 */
interface BottomBarStoreState {
  bars: Record<string, true>;
  register: (id: string) => void;
  unregister: (id: string) => void;
}

export const useBottomBarStore = create<BottomBarStoreState>((set) => ({
  bars: {},
  register: (id) => set((s) => ({ bars: { ...s.bars, [id]: true } })),
  unregister: (id) => set((s) => {
    if (!(id in s.bars)) return s;
    const bars = { ...s.bars };
    delete bars[id];
    return { bars };
  }),
}));
