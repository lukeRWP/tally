import { useEffect, useState } from 'react';

/**
 * Is the PRIMARY pointer a finger?
 *
 * This is the tablet detector behind capture's input-modality fork, and it is
 * deliberately not camera detection: every iMac and MacBook has a webcam,
 * pointed at the operator's face, so `useHasCamera()` would hand the camera
 * flow to exactly the machines the manual form was built for. The primary
 * pointer tracks what the hands are actually doing.
 *
 * Convertibles report the pointer that is primary RIGHT NOW: a Surface with
 * its keyboard docked is fine-pointer (form), undocked it is coarse (camera
 * flow). The change listener makes docking mid-session take effect without a
 * reload. That is the right answer, not a limitation.
 *
 * Mirrors use-layout-mode.ts: a hook, not a Tailwind variant, because
 * `pointer-coarse:` emits no CSS in this project's build (verified there),
 * and because exactly one capture experience should render.
 */
export const COARSE_QUERY = '(pointer: coarse)';

/** Read once, so the first paint is already correct rather than flipping. */
function currentlyCoarse(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(currentlyCoarse);

  useEffect(() => {
    // Same guard as currentlyCoarse: jsdom builds no matchMedia, and suites
    // that mount a consumer bare (the destination picker's) shouldn't have to
    // stub it just to mean "a desk". Absent matchMedia = fine pointer.
    if (!window.matchMedia) return;
    const mq = window.matchMedia(COARSE_QUERY);
    const onChange = () => setCoarse(mq.matches);
    // Re-read on mount: a dock/undock between the initial render and this
    // effect would otherwise stick until the next change event.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return coarse;
}
