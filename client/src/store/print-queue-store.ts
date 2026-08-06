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
  /** Stage a batch in one write; returns how many were newly staged. */
  addMany: (inputs: StageInput[]) => number;
  remove: (key: string) => void;
  removeMany: (keys: string[]) => void;
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

  removeMany: (keys) => {
    const drop = new Set(keys);
    const next = get().staged.filter((l) => !drop.has(l.key));
    save(next);
    set({ staged: next });
  },

  addMany: (inputs) => {
    // One state write for a whole batch — "Label all bins" stages dozens at
    // once, and per-label add() would persist + re-render per row. Same dedupe
    // rule as add(): re-staging something already staged is a no-op.
    const { staged } = get();
    const have = new Set(staged.map((l) => l.key));
    const fresh = inputs
      .filter((i) => !have.has(`${i.entityType}:${i.id}`))
      .map((i) => ({
        ...i,
        key: `${i.entityType}:${i.id}`,
        preset: i.preset ?? defaultPresetFor(i.entityType),
      }));
    if (fresh.length === 0) return 0;
    const next = [...staged, ...fresh];
    save(next);
    set({ staged: next });
    return fresh.length;
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
 * `POST /api/print/_y_/jobs` takes ONE entityType, ONE preset, ids from ONE
 * property, and at most MAX_IDS_PER_JOB of them — so a mixed batch becomes
 * several jobs. All four constraints are encoded here rather than at the call
 * site, because a group that violates any of them fails as an opaque
 * "Validation failed" with no clue which label caused it.
 *
 * Each group carries the `keys` of the labels that produced it, so a caller
 * that succeeds on some groups and fails on others can un-stage exactly what
 * was sent. Without that the obvious retry reprints everything that already
 * worked — real wasted labels, not a cosmetic bug.
 */
export const MAX_IDS_PER_JOB = 100;   // mirrors entityIds .max(100) in print.schema.js

export interface JobGroup {
  entityType: StagedLabel['entityType'];
  preset: PrintablePreset;
  propertyId?: number;
  entityIds: number[];
  keys: string[];
}

export function groupIntoJobs(staged: StagedLabel[]): JobGroup[] {
  const buckets = new Map<string, { entityType: StagedLabel['entityType']; preset: PrintablePreset; propertyId?: number; entityIds: number[]; keys: string[] }>();
  for (const label of staged) {
    const bucketKey = `${label.propertyId ?? 'none'}|${label.entityType}|${label.preset}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.entityIds.push(label.id);
      existing.keys.push(label.key);
    } else {
      buckets.set(bucketKey, {
        entityType: label.entityType,
        preset: label.preset,
        propertyId: label.propertyId,
        entityIds: [label.id],
        keys: [label.key],
      });
    }
  }

  // Split anything over the server's cap. Labelling a whole room is exactly
  // what this page is for, so 100+ of one type is an ordinary batch, not an
  // edge case.
  const groups: JobGroup[] = [];
  for (const b of buckets.values()) {
    for (let i = 0; i < b.entityIds.length; i += MAX_IDS_PER_JOB) {
      groups.push({
        entityType: b.entityType,
        preset: b.preset,
        propertyId: b.propertyId,
        entityIds: b.entityIds.slice(i, i + MAX_IDS_PER_JOB),
        keys: b.keys.slice(i, i + MAX_IDS_PER_JOB),
      });
    }
  }
  return groups;
}
