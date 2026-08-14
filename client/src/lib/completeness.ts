import type { Item } from '@/types/inventory';

/**
 * What is actually in the bin.
 *
 * 'complete' is deliberately absent: it is the default and the overwhelming
 * majority, so it carries no badge — marking the norm would bury the two cases
 * that change what the row means. A row reading "Dell XPS 15" with no badge is
 * the machine; with one, it is an empty box in a tote.
 */
export const COMPLETENESS_LABEL: Record<string, string> = {
  box_only: 'box only',
  accessories_only: 'spares only',
};

/** True when the thing itself is elsewhere. Excluded from insurance totals. */
export function isPartial(item: Pick<Item, 'completeness'>): boolean {
  return !!item.completeness && item.completeness !== 'complete';
}
