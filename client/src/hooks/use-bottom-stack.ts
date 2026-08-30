import { useEffect, useId } from 'react';
import { useLocation } from 'react-router';
import { useCarryStore } from '@/store/carry-store';
import { useBottomBarStore } from '@/store/bottom-bar-store';

/**
 * The one place that knows every fixed-bottom layer this app can stack:
 * the bottom nav (touch chrome only), the carry banner, and a page's own
 * select-mode action bar (container-detail.tsx and recycle-bin-list.tsx
 * both have one). Four different files used to each compute their own
 * offset from these same facts independently — root-layout.tsx's `<main>`
 * reserve, carry-banner.tsx's dock, a page's own select bar, and toast.tsx's
 * touch offset — which is exactly how the select bar ended up sitting on
 * top of the carry banner's own dock (#286 fix round 2), and how a toast
 * fired mid-bulk-action could still land on the select bar's own buttons
 * (both `selecting` and a toast can be up at once: every bulk action toasts
 * its outcome without leaving select mode). All four now call into this
 * module instead of re-deriving their own number, so a fifth layer never
 * has a reason to reinvent this either.
 *
 * Every consumer needs a CSS value, not a class name: the numbers below are
 * combined at runtime into one of several possible offsets, and Tailwind's
 * BUILD-TIME class scanner cannot see a dynamically-interpolated class name
 * (`` `pb-[${rem}rem]` `` never matches any complete utility it knows to
 * generate) — so every function here returns a ready `calc(...)` string for
 * an inline `style`, not a Tailwind class. That is also what makes this a
 * single source of truth in fact, not just in comment: a consumer that
 * imports one of these functions gets the SAME computation everyone else
 * does, rather than a number that merely started out equal.
 *
 * Layer heights are the same kind of hand-tuned constant every one of those
 * four files already used — not a ResizeObserver measurement — sized from
 * this fix's own harness numbers (see the PR body) plus a margin, the same
 * way `5.5rem`/`9.5rem`/`4.6rem` etc. were already hand-picked before this
 * file existed. A select-mode bar is treated as a single fixed height per
 * chrome (its worst case: two wrapped rows on touch, one row on
 * sidebar/desk — see container-detail.tsx's own #276 fix for why phone
 * width can wrap it) rather than something callers must measure or count
 * lines for themselves, so registering one is a one-line hook call.
 */

/** Touch chrome: how far content needs to sit above the bottom nav. */
const NAV_CLEARANCE_REM = 5;
/** Sidebar/desk chrome: the plain corner margin with nothing else present. */
const DESK_BASE_REM = 1.5;
/** Extra clearance ABOVE the nav/desk base once the carry banner is also up. */
const CARRY_ADD_TOUCH_REM = 4.5;
const CARRY_ADD_WIDE_REM = 5.5;
/** Extra clearance ABOVE whatever's already stacked once a select-mode bar is also up (its own worst-case height, per chrome). */
const BAR_ADD_TOUCH_REM = 7;
const BAR_ADD_WIDE_REM = 4.5;
/** Breathing room between a layer and whatever it's docking directly above. */
const GAP_REM = 0.5;
/**
 * The carry banner's OWN flush-above-the-nav position — tuned slightly
 * tighter than `NAV_CLEARANCE_REM`, which is how much breathing room
 * SCROLLABLE CONTENT wants above the nav, a related but distinct number.
 * Kept as its own named constant (not forced equal) rather than papering
 * over two genuinely different tuned quantities as if they were the same
 * layer twice.
 */
const CARRY_BANNER_TOUCH_OFFSET_REM = 4.6;

function withSafeArea(rem: number): string {
  return `calc(${rem}rem + env(safe-area-inset-bottom))`;
}

export interface StackInputs {
  /** From `useLayoutMode() === 'touch'` (or, equivalently, `!== 'sidebar'`). */
  touch: boolean;
  carrying: boolean;
  /** Is a select-mode-style bar currently registered anywhere (see `useRegisterBottomBar`)? */
  barActive: boolean;
}

/**
 * How much bottom padding, in rem, a scrollable content area needs so its
 * last row clears everything currently stacked below it. Exported alongside
 * the `*Css` wrapper below (not just the string) so tests — and any future
 * numeric consumer — can compare offsets directly instead of parsing them
 * back out of a `calc(...)` string.
 */
export function stackReserveRem({ touch, carrying, barActive }: StackInputs): number {
  let rem = touch ? NAV_CLEARANCE_REM : DESK_BASE_REM;
  if (carrying) rem += touch ? CARRY_ADD_TOUCH_REM : CARRY_ADD_WIDE_REM;
  if (barActive) rem += touch ? BAR_ADD_TOUCH_REM : BAR_ADD_WIDE_REM;
  return rem;
}

/**
 * `padding-bottom` for a scrollable content area so its last row clears
 * everything currently stacked below it. root-layout.tsx's `<main>` is the
 * only consumer today, but any future scrollable region under this same
 * chrome would want the identical number.
 */
export function stackReserveCss(inputs: StackInputs): string {
  return withSafeArea(stackReserveRem(inputs));
}

/**
 * Where a select-mode-style bar should dock, in rem — the reserve for
 * everything BELOW it (nav + carry banner, if present) plus one gap,
 * deliberately excluding its OWN height (a layer never stacks on itself).
 */
export function barOffsetRem({ touch, carrying }: Omit<StackInputs, 'barActive'>): number {
  const below = touch ? NAV_CLEARANCE_REM : DESK_BASE_REM;
  return below + (carrying ? (touch ? CARRY_ADD_TOUCH_REM : CARRY_ADD_WIDE_REM) : 0) + GAP_REM;
}

/**
 * `bottom` for a select-mode-style bar. Covers both chromes; callers pass
 * `touch` from their own `useLayoutMode()` reading rather than relying on a
 * CSS breakpoint, since the two can disagree (`useLayoutMode` is
 * orientation-aware; Tailwind's `lg:` is width-only — see that hook's own
 * doc comment) and the bar's true chrome is already known in JS here.
 */
export function barOffsetCss(inputs: Omit<StackInputs, 'barActive'>): string {
  return withSafeArea(barOffsetRem(inputs));
}

/**
 * `bottom` for the carry banner itself. Desk/sidebar chrome reuses the same
 * base every other desk consumer does (`DESK_BASE_REM`, i.e. Tailwind's
 * `bottom-6`) — nothing stacks below the banner there, so it never needs
 * anything more. Touch chrome uses the banner's own tuned offset above the
 * nav (see `CARRY_BANNER_TOUCH_OFFSET_REM`'s doc comment).
 */
export function carryBannerOffsetCss(touch: boolean): string {
  return withSafeArea(touch ? CARRY_BANNER_TOUCH_OFFSET_REM : DESK_BASE_REM);
}

/**
 * The toast layer's offset — identical inputs and formula to
 * `stackReserveCss`, by construction (same function) rather than by a
 * comment promising the two won't drift: a toast needs to clear the same
 * stack the scrollable content behind it does.
 *
 * Touch chrome always overrides (there is always at least the nav to
 * clear). Desk/sidebar chrome keeps sonner's default centered placement
 * (`undefined`) ONLY while neither the carry banner nor a select bar is up:
 * this used to be unconditional on desk, on the theory that a bottom-RIGHT
 * dock is a different x-range from a centered toast — true for a 1440px+
 * desk against the carry banner's fixed 416px panel, but false at the
 * narrower end of "sidebar" chrome (a 1180px landscape tablet, still >=1024
 * and landscape) where a centered toast's default width reaches past a
 * right-anchored banner, AND false against the select bar specifically at
 * its low (non-carrying) offset now that #276 made its width content-driven
 * instead of a fixed 416px column — both confirmed overlapping by this
 * fix's own harness run (see the PR body) before this override existed.
 */
export function toastOffsetCss(inputs: StackInputs): string | undefined {
  if (!inputs.touch && !inputs.carrying && !inputs.barActive) return undefined;
  return stackReserveCss(inputs);
}

/** Read-only: is any page-local select-mode bar currently registered? */
export function useBottomBarActive(): boolean {
  return useBottomBarStore((s) => Object.keys(s.bars).length > 0);
}

/**
 * Read-only: is the carry banner (an active carry OR its "put back" undo)
 * currently showing? `/move` OWNS both the carrying state and the undo for
 * what it just did, so CarryBanner itself never renders there
 * (carry-banner.tsx's own early return) — this predicate has to match that
 * exactly, or every consumer downstream (root-layout.tsx's `<main>`
 * reserve, a page's own select bar, the toast layer) reserves clearance for
 * a banner that isn't actually on screen. Previously root-layout.tsx kept
 * its own copy of this same `pathname !== '/move'` guard alongside the
 * carry-banner's — unifying the ARITHMETIC but leaving the CONDITION
 * duplicated in three places is exactly how this class of drift grows
 * back, so it lives here now and all three read it from one place.
 */
export function useCarryBannerShowing(): boolean {
  const { pathname } = useLocation();
  return useCarryStore((s) => (s.carried.length > 0 || s.lastMove !== null) && pathname !== '/move');
}

/**
 * Registers this page's select-mode bar for the duration it's on screen, so
 * the toast layer and `<main>`'s reserve (mounted elsewhere, with no other
 * way to see this page's local state) know to clear it too. Call
 * unconditionally with whether the bar is currently rendered — the effect
 * itself handles registering only while `active` is true and always cleans
 * up on unmount or when `active` flips back to false.
 */
export function useRegisterBottomBar(active: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!active) return undefined;
    useBottomBarStore.getState().register(id);
    return () => useBottomBarStore.getState().unregister(id);
  }, [active, id]);
}
