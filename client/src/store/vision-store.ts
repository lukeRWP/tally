import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Whether the capture flow asks what the photo shows.
 *
 * A user-facing off switch, distinct from the two the operator already has
 * (an absent ANTHROPIC_API_KEY, and VISION_ENABLED=false on the server). Those
 * turn the feature off for everyone and need a deploy or a vault change; this
 * one is for "I am adding forty identical boxes and do not want to pay for
 * forty guesses", which is a decision made mid-task.
 *
 * PERSISTED, unlike the carry store: switching it off is a settled preference,
 * and having it silently come back on after a browser restart would spend money
 * the user had decided not to spend. Per-device rather than per-account, which
 * matches how it is actually used — on the phone while cataloguing, off on the
 * laptop — and needs no schema.
 *
 * Default ON. Someone who has never opened Settings should get the feature.
 */
interface VisionPrefState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useVisionPref = create<VisionPrefState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: 'tally-vision-enabled' },
  ),
);
