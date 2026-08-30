import { ItemCard } from '@/components/inventory/item-card';
import { ItemPreview } from '@/components/inventory/item-preview';
import { SplitView } from '@/components/layout/split-view';
import { cn } from '@/lib/utils';
import type { Item } from '@/types/inventory';

/**
 * The answer to "where is X?", however you asked it.
 *
 * There are two entrances to search — Home's field (the landing surface, with
 * the browse filters and recents underneath) and `/search` (autofocused, one
 * tap from every screen, deep-linkable). There is no reason for there to be
 * two answers, and there were: `/search` grew a split view with a live preview
 * pane while Home — the app's root, and so the entrance nearly everyone
 * actually uses — kept rendering fifty 1100px-wide rows into a 1440px window
 * (#274). Whichever entrance you came through now lands on this.
 *
 * At a desk the results become a list beside a preview: "where does it live"
 * is usually one line, and reading it should not cost a page load and a Back.
 * On touch it stays the plain ruled list — a 390px screen has no room to split,
 * and there the answer IS to navigate.
 *
 * Rows carry `data-nav-id` so the keyboard ring (`use-keyboard-nav`) and
 * `useNavScrollIntoView` work identically on both pages, and the DOM order is
 * the reading order — one column, so no grid-flow subtlety to get wrong.
 *
 * The section head is deliberately NOT here: it is a full-width rule above this
 * on every surface in the app, and it has to keep rendering when the result set
 * is empty or still loading, which this does not.
 */
export function SearchResults({
  items,
  split,
  selectedId,
  onSelect,
}: {
  items: Item[];
  /** Desk chrome — the caller decides (`useLayoutMode() === 'sidebar'`). */
  split: boolean;
  /** The ringed/previewed row, or null. */
  selectedId: number | null;
  /** Only consulted when `split` — otherwise a row navigates, as before. */
  onSelect?: (id: number) => void;
}) {
  const list = items.map((item) => (
    <div
      key={item.id}
      data-nav-id={item.id}
      className={cn(
        // The hairline lives on the wrapper, not on RuledRow: RuledRow drops
        // its own bottom border when it is the last child, and wrapping every
        // row made every row the last child of its wrapper. That is how
        // /search's split list quietly lost the rules that are the design
        // language on every other list in the app.
        'rounded-[var(--radius-sm)] border-b border-[var(--color-rule)] last:border-b-0',
        selectedId === item.id && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
      )}
    >
      {/* A row SELECTS rather than navigates only when there is a pane for the
          selection to land in — RuledRow owns the click, so this cannot be
          done from outside the card. */}
      <ItemCard item={item} onSelect={split && onSelect ? () => onSelect(item.id) : undefined} />
    </div>
  ));

  if (!split) return <>{list}</>;

  return <SplitView list={<>{list}</>} detail={<ItemPreview itemId={selectedId} />} />;
}
