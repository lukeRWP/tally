import { Toaster as SonnerToaster } from 'sonner';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { toastOffsetCss, useBottomBarActive, useCarryBannerShowing } from '@/hooks/use-bottom-stack';

export { toast } from 'sonner';

/**
 * Placement policy (#265). Three reviewers hit this independently on three
 * surfaces — capture's Name field, /move's pinned-destination banner + Done,
 * matches' item-name header — and every one of those hot zones sits at the
 * TOP of its page. That's not a coincidence: `top-center` was written for a
 * single phone column, and all three surfaces are two-column layouts the
 * toast had never shared a screen with before. None of the three puts a
 * primary control at the BOTTOM, so bottom-center is the one placement that
 * clears all three at once — a shared-chrome decision, not three per-surface
 * patches (rejected: giving each panel `relative z-40`, which papers over the
 * same placement bug three times).
 *
 * Touch chrome (phone, and any tablet in portrait) needs its own offset from
 * the bottom edge: the bottom nav (`bottom-nav.tsx`) owns the literal bottom
 * of the screen, the carry banner docks directly above it whenever something
 * is in hand, and a page's own select-mode bar (container-detail.tsx,
 * recycle-bin-list.tsx) can be up too — every bulk action toasts its outcome
 * WITHOUT leaving select mode, so a toast and that bar are routinely on
 * screen together.
 *
 * Desk/sidebar chrome (every desk, plus a tablet in landscape) docks the
 * carry banner and any select bar bottom-RIGHT instead of full-width, which
 * clears a centered toast MOST of the time — but not always: at the
 * narrower end of that chrome (a 1180px landscape tablet is still
 * `sidebar`), a centered toast's default width reaches past a right-anchored
 * carry banner, and the select bar specifically can reach even further left
 * at its low (non-carrying) offset now that #276 made its width
 * content-driven instead of a fixed column. Both were confirmed actually
 * overlapping by this fix's own harness run (see the PR body) — sidebar
 * chrome needs the SAME override touch chrome always did, just only while
 * something is actually stacked (an empty desk keeps sonner's default).
 *
 * `toastOffsetCss` (use-bottom-stack.ts) is the same function
 * root-layout.tsx's own `<main>` reserve calls for its padding, on both
 * chromes, so this can't drift from what the content (or another fixed
 * layer) behind the toast already clears — previously touch chrome used a
 * single hardcoded worst-case constant that (a) didn't know about the
 * select bar at all, so a toast fired during a bulk action could land on
 * the bar's own buttons, and (b) always assumed carrying even when nothing
 * was in hand; desk chrome had no override at all.
 *
 * `mobileOffset` is set alongside `offset` (not left to sonner's own default)
 * because sonner switches to `--mobile-offset-*` under its own `(max-width:
 * 600px)` query, which is a different breakpoint than this app's own
 * touch/sidebar split (`use-layout-mode.ts`) — a phone is under both, but an
 * iPad in touch (portrait) mode is not, and would otherwise fall back to
 * sonner's unrelated default.
 */
export function Toaster() {
  const touch = useLayoutMode() === 'touch';
  const carrying = useCarryBannerShowing();
  const barActive = useBottomBarActive();
  const offset = toastOffsetCss({ touch, carrying, barActive });
  return (
    <SonnerToaster
      position="bottom-center"
      offset={offset ? { bottom: offset } : undefined}
      mobileOffset={offset ? { bottom: offset } : undefined}
      toastOptions={{
        style: {
          background: 'var(--color-card)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text)',
        },
      }}
    />
  );
}
