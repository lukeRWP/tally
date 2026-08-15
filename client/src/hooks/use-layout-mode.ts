import { useEffect, useState } from 'react';

/**
 * Which chrome the app wears.
 *
 * 'touch'   bottom nav with Scan in the thumb slot
 * 'sidebar' fixed left rail, no bottom nav
 *
 * Width alone was the wrong test. The rule used to be "sidebar at 1280+", so an
 * iPad in landscape got phone chrome and spent 18% of its 768px of height on a
 * header and a bottom bar — on the axis that is scarce in landscape. Moving the
 * cutoff down to 1024 would have been worse: it would also have caught iPad
 * PORTRAIT, which is genuinely the carried-to-the-shelf case the bottom nav and
 * Scan exist for.
 *
 * So the test is width AND orientation, which tracks how the device is being
 * held: portrait is being carried, landscape is propped on a bench or sitting
 * on a desk. A phone in landscape is still under 1024 and stays on touch chrome.
 *
 * This is a hook rather than a Tailwind variant because the two navs should not
 * both exist. Rendering both and hiding one leaves a second set of nav controls
 * in the accessibility tree, and `landscape:`/`pointer-coarse:` do not emit in
 * this project's Tailwind build (verified — `hover` does, those do not).
 */
export type LayoutMode = 'touch' | 'sidebar';

export const SIDEBAR_QUERY = '(min-width: 1024px) and (orientation: landscape)';

/** Read once, so the first paint is already correct rather than flipping. */
function currentMode(): LayoutMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'touch';
  return window.matchMedia(SIDEBAR_QUERY).matches ? 'sidebar' : 'touch';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(currentMode);

  useEffect(() => {
    const mq = window.matchMedia(SIDEBAR_QUERY);
    const onChange = () => setMode(mq.matches ? 'sidebar' : 'touch');
    // Re-read on mount: a rotation between the initial render and this effect
    // would otherwise leave the wrong chrome until the next change event.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return mode;
}
