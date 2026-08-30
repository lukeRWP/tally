import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Search, ChevronDown, Filter, X, ScanLine, ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav, useNavCursorParam, useNavScrollIntoView } from '@/hooks/use-keyboard-nav';
import type { Property } from '@/types/inventory';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ItemCard } from '@/components/inventory/item-card';
import { ItemTile } from '@/components/inventory/item-tile';
import { SearchResults } from '@/components/inventory/search-results';
import { TagBadge } from '@/components/tags/tag-badge';
import { useProperties, useRecentItems, useSearchItems, type SearchFilters } from '@/hooks/use-inventory';
import { usePropertyTags, type Tag } from '@/hooks/use-tags';
import { extractTlyCode } from '@/lib/tly';
import { cn } from '@/lib/utils';

// -- AllPropertyTags: fetch tags across all user properties --------------------

function useAllPropertyTags(properties: Array<{ id: number }> | undefined): Tag[] {
  // Call hooks for up to 10 properties (hooks must not be called conditionally).
  // We gate on `enabled` to avoid firing requests for unused slots.
  const p0 = usePropertyTags(properties?.[0]?.id ?? 0);
  const p1 = usePropertyTags(properties?.[1]?.id ?? 0);
  const p2 = usePropertyTags(properties?.[2]?.id ?? 0);
  const p3 = usePropertyTags(properties?.[3]?.id ?? 0);
  const p4 = usePropertyTags(properties?.[4]?.id ?? 0);
  const p5 = usePropertyTags(properties?.[5]?.id ?? 0);
  const p6 = usePropertyTags(properties?.[6]?.id ?? 0);
  const p7 = usePropertyTags(properties?.[7]?.id ?? 0);
  const p8 = usePropertyTags(properties?.[8]?.id ?? 0);
  const p9 = usePropertyTags(properties?.[9]?.id ?? 0);

  const count = properties?.length ?? 0;
  const all = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9]
    .slice(0, count)
    .flatMap((q) => (q.data as Tag[] | undefined) ?? []);

  // Deduplicate by tag ID
  const seen = new Set<number>();
  return all.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// -- Pill button -------------------------------------------------------------

function PillButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 border',
        active
          ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
          : 'bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
      )}
    >
      {label}
    </button>
  );
}

// -- Filter options ----------------------------------------------------------

const CONDITIONS: Array<{ label: string; value: string | null }> = [
  { label: 'All', value: null },
  { label: 'New', value: 'new' },
  { label: 'Good', value: 'good' },
  { label: 'Fair', value: 'fair' },
  { label: 'Poor', value: 'poor' },
];

const STATUSES: Array<{ label: string; value: string }> = [
  // 'All' first and default: the thing you most need to FIND is often exactly
  // the thing that is lent out — hiding those by default made search return
  // zero results for the very item you were hunting.
  //
  // There is no 'Removed' option. Soft-deleted rows always carry DELETED_AT and
  // search always excludes them, so it could never match anything; deleted
  // things live in the Recycle Bin.
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Lent', value: 'lent' },
];

// -- Home page ---------------------------------------------------------------

/**
 * Two questions, one screen. "Where is my X" is the search field at the top,
 * with the filters that narrow it. "What did we just put away" is the list
 * underneath, which is what a landing screen can usefully answer when you
 * arrived without anything particular in mind — and it is what the search
 * results temporarily stand in front of, never replace.
 *
 * Browsing the house by place has a tab of its own, so no property list here.
 *
 * Home and `/search` are two ENTRANCES to one job, not two jobs (#274). This
 * one is the landing: it carries the tag/condition/status filters and keeps
 * recents behind the results, because you arrive here without having decided
 * to search yet. `/search` is the jump: autofocused, one tap from every
 * screen, deep-linkable. What they must never differ on is the ANSWER — the
 * results themselves render through the shared `SearchResults`, so the desk
 * split-and-preview and the touch ruled list are the same on both.
 */
export function Home() {
  // Above any early return: hooks must run on every render.
  const wide = useLayoutMode() === 'sidebar';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Hydrated from the URL on mount so tapping a result and pressing Back
  // restores the search instead of dumping the user on recents. Both
  // searchInput and searchQuery seed from `q` — hydrating only the debounced
  // one would leave the input box empty while results are still showing.
  const [searchInput, setSearchInput] = React.useState(() => searchParams.get('q') ?? '');
  const [searchQuery, setSearchQuery] = React.useState(() => searchParams.get('q') ?? '');
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  // The results stand in front of the recent list rather than replacing it, so
  // the exit is always the same gesture: empty the field, get the house back.
  // Declared up here (not just once near the return) because the keyboard
  // ring below needs it too.
  const searching = searchQuery.length >= 1;

  // Filter state — also hydrated at mount. `tags` is comma-joined ids, and
  // `status` is only ever written when it isn't the 'all' default.
  const [selectedTagIds, setSelectedTagIds] = React.useState<number[]>(() => {
    const raw = searchParams.get('tags');
    if (!raw) return [];
    return raw.split(',').map(Number).filter((n) => !Number.isNaN(n));
  });
  const [selectedCondition, setSelectedCondition] = React.useState<string | null>(
    () => searchParams.get('condition') ?? null,
  );
  const [selectedStatus, setSelectedStatus] = React.useState<string>(
    () => searchParams.get('status') ?? 'all',
  );

  // Filter panel visibility (collapsible on mobile)
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // Tag dropdown
  const [tagDropdownOpen, setTagDropdownOpen] = React.useState(false);
  const tagDropdownRef = React.useRef<HTMLDivElement>(null);

  const {
    data: properties,
    isLoading: propertiesLoading,
    isError: propertiesError,
    refetch: refetchProperties,
  } = useProperties();
  const allTags = useAllPropertyTags(properties);
  const {
    data: recentItems,
    isLoading: recentLoading,
    isError: recentError,
    refetch: refetchRecent,
  } = useRecentItems();

  // Build filters for search
  const filters: SearchFilters = {
    tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    condition: selectedCondition ?? undefined,
    status: selectedStatus === 'all' ? undefined : selectedStatus,
  };

  const {
    data: searchResults,
    isLoading: searchLoading,
    isError: searchError,
    isPlaceholderData: searchIsPlaceholder,
    refetch: refetchSearch,
  } = useSearchItems(searchQuery, filters);
  // #238: `useSearchItems` keeps the previous result set mounted (marked
  // placeholder) while a new query settles, so the list's height — and the
  // shared scroll container's position — never collapses out from under the
  // user. That means `searchResults` can briefly be the OLD query's rows (or
  // its empty list) while `searchQuery` already reads the NEW one — the
  // empty-state message below names `searchQuery` directly, so showing it
  // off placeholder data would tell the user "no items for X" about a query
  // that hasn't actually been searched yet. Gated below on `!searchIsPlaceholder`.
  const showSkeleton = searchLoading || (searchIsPlaceholder && (searchResults?.length ?? 0) === 0);

  // Debounce search
  React.useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /**
   * The keyboard ring, over search RESULTS only — recents is a browsable grid
   * of tiles/cards, not a worked list, so there is nothing here for j/k to
   * walk until a search is actually running. `/` still works everywhere
   * (`onSearch` is unconditional), matching search.tsx's own contract for it.
   */
  const resultIds = React.useMemo(() => (searchResults ?? []).map((r) => r.id), [searchResults]);
  /**
   * The cursor lives in `?sel`, not in state (#270).
   *
   * Held in useState it died on every Back — scroll restoration put the list
   * back at the pixel you left and the highlight did not come with it, so the
   * next `j` re-seeded at result 1, off the top of the viewport, moving
   * nothing visible. The URL is what POP restores, so cursor and pixels come
   * back together; every write is a same-pathname REPLACE, which
   * use-scroll-restoration.ts deliberately ignores. Same shape as search.tsx.
   */
  const { cursor: selParam, setCursor } = useNavCursorParam('sel');
  const highlightedId = React.useMemo(() => {
    if (selParam == null) return null;
    const n = Number(selParam);
    return Number.isFinite(n) ? n : null;
  }, [selParam]);
  /**
   * The query the cursor belongs to. A new query re-ranks (or replaces) the
   * result set, so a stale id surviving into it could highlight an unrelated
   * row that happens to share an id — the cursor must be dropped.
   *
   * Compared by VALUE rather than counting effect runs: the query the URL
   * arrived with must not clear the cursor Back just restored (#270), and a
   * run-counter gets that wrong under StrictMode's deliberate second mount,
   * which replays effects with unchanged deps.
   *
   * The clear itself is folded into the URL-sync effect below rather than
   * living in an effect of its own — see there.
   */
  const cursorQuery = React.useRef(searchQuery);
  const moveHighlight = React.useCallback((delta: 1 | -1) => {
    if (resultIds.length === 0) return;
    const at = highlightedId == null ? -1 : resultIds.indexOf(highlightedId);
    const next = at === -1
      ? (delta === 1 ? 0 : resultIds.length - 1)
      : Math.min(resultIds.length - 1, Math.max(0, at + delta));
    setCursor(String(resultIds[next]));
  }, [resultIds, highlightedId, setCursor]);
  useKeyboardNav({
    enabled: wide,
    onSearch: () => searchInputRef.current?.focus(),
    onMove: searching ? moveHighlight : undefined,
    onOpen: searching
      ? () => {
        if (highlightedId == null) return false;
        navigate(`/item/${highlightedId}`);
        return true;
      }
      : undefined,
    onEscape: searching ? () => setCursor(null) : undefined,
    // Tab onto a result row IS a cursor move (#279) — only result rows carry
    // data-nav-id here, so recents can never seed a ring it doesn't have.
    onFocusRow: searching
      ? (navId) => {
        const n = Number(navId);
        if (Number.isFinite(n) && resultIds.includes(n)) setCursor(String(n));
      }
      : undefined,
  });
  // Keeps the cursor on screen past one screenful of results (#235) — the
  // result rows below carry the matching data-nav-id.
  useNavScrollIntoView(highlightedId);

  // Mirror the settled query and filters into the URL so Back restores this
  // screen's search instead of dumping the user on recents. `replace` keeps
  // keystrokes from flooding history — Back always leaves Home, never
  // rewinds through one keystroke at a time. This effect only ever writes
  // params FROM state; nothing reads params back into state after mount, or
  // typing and navigation would fight each other.
  React.useEffect(() => {
    // Dropping the ring's cursor on a query change belongs HERE, in the same
    // write, not in an effect of its own (#270 review). React Router's
    // functional setSearchParams hands the updater the params from its own
    // render's closure rather than the live URL, so two writers landing in
    // one effect flush both merge from the same stale snapshot — a separate
    // `sel`-clearing effect deleted the param and this one, merging from a
    // snapshot that still had it, put it straight back. The URL then read
    // `?q=hammer&sel=2`: nothing ringed on screen, and Enter opening a row
    // from the PREVIOUS result set.
    const queryChanged = cursorQuery.current !== searchQuery;
    cursorQuery.current = searchQuery;
    // MERGE, do not rebuild. Building a fresh URLSearchParams from just this
    // screen's own keys would silently drop any unrelated param already in
    // the URL — see search.tsx's sync effect for the same reasoning.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (searchQuery) next.set('q', searchQuery); else next.delete('q');
      if (selectedTagIds.length > 0) next.set('tags', selectedTagIds.join(',')); else next.delete('tags');
      if (selectedCondition) next.set('condition', selectedCondition); else next.delete('condition');
      if (selectedStatus !== 'all') next.set('status', selectedStatus); else next.delete('status');
      if (queryChanged) next.delete('sel');
      return next;
    }, { replace: true });
  }, [searchQuery, selectedTagIds, selectedCondition, selectedStatus, setSearchParams]);

  // Close tag dropdown on outside click
  React.useEffect(() => {
    if (!tagDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [tagDropdownOpen]);

  function toggleTag(tagId: number) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  function removeSelectedTag(tagId: number) {
    setSelectedTagIds((prev) => prev.filter((id) => id !== tagId));
  }

  // Drop the settled query as well as the input: waiting out the debounce
  // before the recent list comes back reads as a hang, not a clear.
  function clearSearch() {
    setSearchInput('');
    setSearchQuery('');
  }

  /**
   * A tally code pasted into Home's box goes where the code points.
   *
   * `/search` has done this since it was built, and Home — the box people
   * actually type into, because Home is the app's root — returned "Nothing
   * matched" for a perfectly valid label, because the code is in neither NAME
   * nor DESCRIPTION. Two entrances to one job must not disagree about what
   * the job is (#274). Read off the live input rather than the debounced
   * query so a paste resolves immediately instead of 300ms later.
   */
  const typedCode = extractTlyCode(searchInput);

  const selectedTags = allTags.filter((t) => selectedTagIds.includes(t.id));
  const hasActiveFilters =
    selectedTagIds.length > 0 || selectedCondition !== null || selectedStatus !== 'all';

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative animate-fade-up">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-[var(--color-text-muted)]" />
        <Input
          ref={searchInputRef}
          placeholder="Search items..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-10 pr-20 h-12 text-base bg-[var(--color-elevated)] focus:shadow-[inset_0_0_0_2px_var(--color-primary)] transition-shadow duration-200"
        />
        {searchInput.length > 0 && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-10 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 -mr-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors duration-200"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            'absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-xs transition-colors duration-200',
            filtersOpen || hasActiveFilters
              ? 'text-[var(--color-primary)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          )}
          aria-label="Toggle filters"
        >
          <Filter className="w-4 h-4" />
          {hasActiveFilters && (
            <span className="text-[10px] font-semibold leading-none">
              {(selectedTagIds.length > 0 ? 1 : 0) +
                (selectedCondition !== null ? 1 : 0) +
                (selectedStatus !== 'all' ? 1 : 0)}
            </span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div className="flex flex-col gap-3 p-3 rounded-[var(--radius-lg)] bg-[var(--color-elevated)] border border-[var(--color-border)] animate-scale-in">
          {/* Tag filter */}
          {allTags.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
                Tags
              </p>
              <div className="relative" ref={tagDropdownRef}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTagDropdownOpen((v) => !v)}
                  className="h-7 px-2.5 text-xs gap-1"
                >
                  Tags
                  {selectedTagIds.length > 0 && (
                    <span className="ml-0.5 text-[var(--color-primary)] font-semibold">
                      ({selectedTagIds.length})
                    </span>
                  )}
                  <ChevronDown
                    className={cn('w-3 h-3 transition-transform duration-200', tagDropdownOpen && 'rotate-180')}
                  />
                </Button>

                {tagDropdownOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-1.5 flex flex-col gap-0.5 animate-scale-in">
                    {allTags.map((tag) => {
                      const isSelected = selectedTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-left transition-all duration-150 w-full',
                            isSelected
                              ? 'bg-[var(--color-primary-bg)]'
                              : 'hover:bg-[var(--color-elevated)]',
                          )}
                        >
                          <div
                            className="w-3 h-3 rounded-sm shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="text-sm text-[var(--color-text)]">{tag.name}</span>
                          {isSelected && (
                            <span className="ml-auto text-[var(--color-primary)] text-xs font-bold">
                              ✓
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Selected tag chips */}
              {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selectedTags.map((tag) => (
                    <TagBadge key={tag.id} tag={tag} size="sm" onRemove={() => removeSelectedTag(tag.id)} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Condition filter */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
              Condition
            </p>
            <div className="flex flex-wrap gap-1.5">
              {CONDITIONS.map(({ label, value }) => (
                <PillButton
                  key={label}
                  label={label}
                  active={selectedCondition === value}
                  onClick={() => setSelectedCondition(value)}
                />
              ))}
            </div>
          </div>

          {/* Status filter */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
              Status
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map(({ label, value }) => (
                <PillButton
                  key={value}
                  label={label}
                  active={selectedStatus === value}
                  onClick={() => setSelectedStatus(value)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {typedCode ? (
        /* A code goes where it points, ahead of any text matching — same card,
           same wording, same behaviour as /search's. */
        <button
          type="button"
          onClick={() => navigate(`/s/${typedCode}`)}
          className="flex w-full items-center gap-3 rounded-[var(--radius-sm)] border-2 border-[var(--color-text)] px-3 py-3 text-left hover:bg-[var(--color-elevated)] animate-fade-up"
        >
          <ScanLine className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              that is a tally code
            </span>
            <span className="block truncate text-sm font-semibold">Go to {typedCode}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" />
        </button>
      ) : searching ? (
        <section className="flex flex-col animate-fade-up">
          {/* The way back to the recent list is named on the list that hid it,
              not just parked in the field's corner. */}
          <ColHead action="Clear ✕" onAction={clearSearch}>
            Results{searchResults ? ` · ${searchResults.length}` : ''}
          </ColHead>

          {showSkeleton && (
            <div className="flex flex-col gap-2 mt-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}

          {/* A search that fell over and a search that matched nothing are the
              same blank screen otherwise, and only one of them is worth
              retyping the query for. */}
          {searchError && (
            <ErrorState message="Couldn't run that search." onRetry={() => refetchSearch()} />
          )}

          {!showSkeleton && !searchIsPlaceholder && searchResults && searchResults.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                Nothing matched
              </p>
              <p className="max-w-xs text-sm text-[var(--color-text-secondary)]">
                No items for &ldquo;{searchQuery}&rdquo;
                {hasActiveFilters && ' with these filters'}.
              </p>
              <Button variant="outline" size="sm" onClick={clearSearch}>
                Back to recent
              </Button>
            </div>
          )}

          {/* The desk gets the list beside a preview pane, exactly as /search
              does — same component, so the two entrances to the app's #1 job
              can no longer drift apart (#274). `highlightedId` IS the ring's
              cursor, so the pane follows j/k as well as the mouse, and
              `setCursor` stays the one writer of `?sel`. */}
          {searchResults && searchResults.length > 0 && (
            <SearchResults
              items={searchResults}
              split={wide}
              selectedId={highlightedId}
              onSelect={(id) => setCursor(String(id))}
            />
          )}
        </section>
      ) : (
        <section className="flex flex-col animate-fade-up">
          {wide && <div className="mb-4"><HouseTotals properties={properties} /></div>}
          <ColHead>Recently added{recentItems?.length ? ` · ${recentItems.length}` : ''}</ColHead>

          {recentLoading && (
            <div className="flex flex-col gap-2 mt-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}

          {/* "You own nothing" is a worse lie on this screen than anywhere
              else — it is the one people open to reassure themselves the
              inventory is still there. */}
          {recentError && (
            <ErrorState message="Couldn't load your recent items." onRetry={() => refetchRecent()} />
          )}

          {/* Which empty state is true depends on the property list, and that
              request counts the whole house so it lands well after this one.
              Guessing from a list that has not arrived tells a house full of
              places that it has none. */}
          {!recentLoading && !recentError && recentItems && recentItems.length === 0 && (
            propertiesLoading ? (
              <div className="flex flex-col gap-2 mt-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : propertiesError ? (
              <ErrorState
                message="Couldn't check what's set up here."
                onRetry={() => refetchProperties()}
              />
            ) : (
              <EmptyHouse properties={properties} onGo={(path) => navigate(path)} />
            )
          )}

          {/* A grid of tiles at a desk. "Recently added" is a browsable set, not
              a list you work down — the question is "which of these?", and a
              picture answers that faster than a name on a rule. Rows stay on
              the phone, where a 390px tile shows less than the row it replaced. */}
          {wide ? (
            <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {!recentError && recentItems?.map((item) => (
                <ItemTile key={item.id} item={item} />
              ))}
            </div>
          ) : (
            !recentError && recentItems?.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))
          )}
        </section>
      )}
    </div>
  );
}

/**
 * What the house adds up to, at a glance.
 *
 * A desk can answer "how much is there?" before you scroll, and the property
 * list already carries every number — this costs no request. It is deliberately
 * absent on a phone, where the same strip would push the recent items, which
 * are the reason people open this screen, below the fold.
 */
function HouseTotals({ properties }: { properties: Property[] | undefined }) {
  if (!properties || properties.length === 0) return null;
  const sum = (pick: (p: Property) => number) => properties.reduce((t, p) => t + (pick(p) || 0), 0);
  const stats = [
    { k: properties.length === 1 ? 'Property' : 'Properties', v: properties.length },
    { k: 'Areas', v: sum((p) => p.areaCount) },
    { k: 'Containers', v: sum((p) => p.containerCount) },
    { k: 'Items', v: sum((p) => p.itemCount) },
  ];
  return (
    <div className="grid grid-cols-4 gap-3 animate-fade-up">
      {stats.map(({ k, v }) => (
        <div key={k} className="border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] px-3 py-2">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
            {k}
          </span>
          <span className="block font-mono text-2xl font-bold tabular-nums leading-tight">
            {v.toLocaleString('en-US')}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Filing a thing needs a bin, a bin needs an area, an area needs a property.
 * An empty list names the missing link in that chain and sends you to the page
 * that makes it — the camera flow cannot finish against a destination picker
 * with nothing in it, so "tap Add" is only true once a bin exists.
 */
function EmptyHouse({
  properties,
  onGo,
}: {
  properties: Array<{ containerCount: number }> | undefined;
  onGo: (path: string) => void;
}) {
  const hasProperty = (properties?.length ?? 0) > 0;
  const hasBin = (properties ?? []).some((p) => p.containerCount > 0);

  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        {!hasProperty ? 'No property yet' : !hasBin ? 'Nowhere to put things' : 'Nothing filed yet'}
      </p>
      <p className="max-w-xs text-sm text-[var(--color-text-secondary)]">
        {!hasProperty
          ? 'Start with the building — a house, a flat, a lock-up. Areas and bins hang off it.'
          : !hasBin
            ? 'Add an area and a bin, then things have somewhere to land.'
            : 'Tap Add and photograph the first thing.'}
      </p>
      <Button size="sm" onClick={() => onGo(hasBin ? '/capture' : '/areas')}>
        {hasBin ? 'Add an item' : 'Set up a place'}
      </Button>
    </div>
  );
}
