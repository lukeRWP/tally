import { create } from 'zustand';
import type { PrintablePreset } from '@/hooks/use-print';

/**
 * The staging area behind the print queue page.
 *
 * Purely client-side and deliberately so: a batch you are still assembling is
 * not a server concern, and keeping it local means adding a label costs no
 * request and works while you walk around a room with patchy wifi. Only when
 * you hit Print does any of it reach tally.
 *
 * Persisted to localStorage (matching how auth-store handles `theme` — this
 * codebase does not use zustand's persist middleware) so a batch survives a
 * refresh or navigating away mid-collection.
 */

const STORAGE_KEY = 'tally-print-queue';

export interface StagedLabel {
  /** `${entityType}:${id}` — the dedupe identity, since ids only unique per type. */
  key: string;
  id: number;
  entityType: 'item' | 'container' | 'area';
  name: string;
  qrCode: string;
  propertyId?: number;
  preset: PrintablePreset;
}

/** What the label dialog / detail pages hand us; preset is optional. */
export type StageInput = Omit<StagedLabel, 'key' | 'preset'> & { preset?: PrintablePreset };

/** An item tag is small; a bin or a room reads from across the room. */
export function defaultPresetFor(entityType: StagedLabel['entityType']): PrintablePreset {
  return entityType === 'item' ? 'small' : 'medium';
}

function load(): StagedLabel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: a stale shape from an older build must not wedge the page.
    return parsed.filter(
      (l): l is StagedLabel =>
        l && typeof l.id === 'number' && typeof l.key === 'string' && typeof l.preset === 'string',
    );
  } catch {
    return [];
  }
}

function save(staged: StagedLabel[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(staged));
  } catch {
    /* private mode or quota — the queue still works for this session */
  }
}

interface PrintQueueState {
  staged: StagedLabel[];
  add: (input: StageInput) => void;
  remove: (key: string) => void;
  clear: () => void;
  setPreset: (key: string, preset: PrintablePreset) => void;
  setAllPresets: (preset: PrintablePreset) => void;
  has: (entityType: StagedLabel['entityType'], id: number) => boolean;
}

export const usePrintQueueStore = create<PrintQueueState>((set, get) => ({
  staged: load(),

  add: (input) => {
    const key = `${input.entityType}:${input.id}`;
    const { staged } = get();
    // Adding the same label twice is a slip, not a request for two copies —
    // quantity is what the preset selector and a second Print are for.
    if (staged.some((l) => l.key === key)) return;
    const next = [
      ...staged,
      { ...input, key, preset: input.preset ?? defaultPresetFor(input.entityType) },
    ];
    save(next);
    set({ staged: next });
  },

  remove: (key) => {
    const next = get().staged.filter((l) => l.key !== key);
    save(next);
    set({ staged: next });
  },

  clear: () => {
    save([]);
    set({ staged: [] });
  },

  setPreset: (key, preset) => {
    const next = get().staged.map((l) => (l.key === key ? { ...l, preset } : l));
    save(next);
    set({ staged: next });
  },

  setAllPresets: (preset) => {
    // `large` is a contents manifest, meaningless for an item — never force it
    // onto one via a bulk change.
    const next = get().staged.map((l) =>
      preset === 'large' && l.entityType === 'item' ? l : { ...l, preset },
    );
    save(next);
    set({ staged: next });
  },

  has: (entityType, id) => get().staged.some((l) => l.key === `${entityType}:${id}`),
}));

/**
 * Group a staged batch into the jobs tally will accept.
 *
 * `POST /api/print/_y_/jobs` takes ONE entityType, ONE preset and a list of ids
 * that must all belong to the same property — so a mixed batch becomes several
 * jobs. Exported for its own test: the grouping is the part most likely to
 * silently drop labels.
 */
export function groupIntoJobs(staged: StagedLabel[]) {
  const groups = new Map<
    string,
    { entityType: StagedLabel['entityType']; preset: PrintablePreset; propertyId?: number; entityIds: number[] }
  >();
  for (const label of staged) {
    const groupKey = `${label.propertyId ?? 'none'}|${label.entityType}|${label.preset}`;
    const existing = groups.get(groupKey);
    if (existing) existing.entityIds.push(label.id);
    else
      groups.set(groupKey, {
        entityType: label.entityType,
        preset: label.preset,
        propertyId: label.propertyId,
        entityIds: [label.id],
      });
  }
  return [...groups.values()];
}
