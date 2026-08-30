import { Toaster as SonnerToaster } from 'sonner';
import { useLayoutMode } from '@/hooks/use-layout-mode';

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
 * of the screen, and the carry banner — whenever something is in hand —
 * docks directly above it, spanning nearly the full width
 * (`carry-banner.tsx`'s `left-3 right-3` dock). A plain bottom-center would
 * trade the three collisions this fix closes for a fourth, worse one: a toast
 * sitting on top of the bottom nav on every touch page. The offset below
 * matches root-layout.tsx's own reserved gutter for that same nav+banner
 * strip (`pb-[calc(9.5rem+env(safe-area-inset-bottom))]`) rather than a
 * second number invented here that could quietly drift from it.
 *
 * At a desk (`sidebar` layout — every desk, plus a tablet in landscape) the
 * carry banner docks bottom-RIGHT instead (`bottom-6 right-6 w-[26rem]`), a
 * different x-range from a centered toast, so the default 24px viewport
 * offset already clears it — no override needed there.
 *
 * `mobileOffset` is set alongside `offset` (not left to sonner's own default)
 * because sonner switches to `--mobile-offset-*` under its own `(max-width:
 * 600px)` query, which is a different breakpoint than this app's own
 * touch/sidebar split (`use-layout-mode.ts`) — a phone is under both, but an
 * iPad in touch (portrait) mode is not, and would otherwise fall back to
 * sonner's unrelated default.
 */
const TOUCH_BOTTOM_OFFSET = 'calc(9.5rem + env(safe-area-inset-bottom))';

export function Toaster() {
  const touch = useLayoutMode() === 'touch';
  return (
    <SonnerToaster
      position="bottom-center"
      offset={touch ? { bottom: TOUCH_BOTTOM_OFFSET } : undefined}
      mobileOffset={touch ? { bottom: TOUCH_BOTTOM_OFFSET } : undefined}
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
