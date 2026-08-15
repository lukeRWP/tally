import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search as SearchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { Input } from '@/components/ui/input';
import { ItemCard } from '@/components/inventory/item-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSearchItems } from '@/hooks/use-inventory';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav } from '@/hooks/use-keyboard-nav';
import { SplitView } from '@/components/layout/split-view';
import { ItemPreview } from '@/components/inventory/item-preview';

/**
 * Global search — the surface for the app's #1 job, "Where is X?".
 *
 * Reachable in one tap from every screen (header icon on mobile, sidebar entry
 * on desktop), full-screen, autofocused. Two deliberate defaults, both learned
 * the hard way:
 *
 * - Status defaults to ALL. The thing you most need to find is often exactly
 *   the thing that is lent out; a default of 'active' made the search return
 *   zero results for the very item you were hunting.
 * - There is no 'Removed' chip. Soft-deleted items always carry DELETED_AT,
 *   which search always excludes — the option could never match anything.
 *   Deleted things live in the Recycle Bin, reachable from Settings.
 */

const STATUS_CHIPS: Array<{ label: string; value: string | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Active', value: 'active' },
  { label: 'Lent', value: 'lent' },
];

export function SearchPage() {
  const navigate = useNavigate();
  const split = useLayoutMode() === 'sidebar';
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Seeded from the URL so tapping a result and pressing Back rehydrates the
  // query (and its cached results) instead of dumping you on an empty page.
  const initialQ = (searchParams.get('q') ?? '').trim();
  const [query, setQuery] = React.useState(initialQ);
  const [status, setStatus] = React.useState<string | undefined>(
    searchParams.get('status') ?? undefined,
  );

  // Debounced so we don't fire a request per keystroke (same 300ms the
  // accessory picker uses), and skip 1-char queries that match too broadly.
  // Starts at the URL value, not '' — no placeholder flash on back-nav.
  const [debounced, setDebounced] = React.useState(initialQ.length >= 2 ? initialQ : '');
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().length >= 2 ? query.trim() : ''), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Mirror the settled query into the URL. `replace` keeps typing from
  // flooding history — Back always leaves the page, never rewinds keystrokes.
  React.useEffect(() => {
    // MERGE, do not rebuild. This used to construct a fresh object from q and
    // status alone, so it silently dropped every other param in the URL — the
    // selected result vanished on mount, and any param added later would have
    // gone the same way without anyone touching this line.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (debounced) next.set('q', debounced); else next.delete('q');
      if (status) next.set('status', status); else next.delete('status');
      return next;
    }, { replace: true });
  }, [debounced, status, setSearchParams]);

  const { data: results, isLoading, isError, refetch } = useSearchItems(debounced, { status });

  /**
   * The chosen result, in the URL beside the query.
   *
   * Keeping it here rather than in state means a result you found is a link
   * you can send, and Back steps off the result rather than off the search —
   * which matters most on the one surface people arrive at repeatedly.
   */
  const selectedId = searchParams.get('sel') ? Number(searchParams.get('sel')) : null;
  const select = React.useCallback((id: number | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id == null) next.delete('sel'); else next.set('sel', String(id));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const ids = React.useMemo(() => (results ?? []).map((r) => r.id), [results]);
  useKeyboardNav({
    enabled: split,
    onMove: (delta) => {
      if (ids.length === 0) return;
      const at = selectedId == null ? -1 : ids.indexOf(selectedId);
      const next = at === -1
        ? (delta === 1 ? 0 : ids.length - 1)
        : Math.min(ids.length - 1, Math.max(0, at + delta));
      select(ids[next]);
    },
    onEscape: () => select(null),
    onOpen: () => { if (selectedId != null) navigate(`/item/${selectedId}`); },
    // '/' already lives in this page's own input, so refocusing it is the
    // useful thing rather than navigating to the page you are on.
    onSearch: () => inputRef.current?.focus(),
  });

  return (
    <div className="flex flex-col min-h-full">
      {/* Sticky search bar — back arrow, field, nothing else */}
      <div className="sticky top-0 z-10 bg-[var(--color-bg)] border-b border-[var(--color-border)] px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => {
            // Direct entry (deep link, fresh tab) has no prior in-app entry —
            // popping would do nothing or leave the SPA. Fall back to Home.
            const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
            if (idx > 0) navigate(-1);
            else navigate('/');
          }}
          className="p-2 -ml-1 rounded-[var(--radius-md)] text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <Input
            ref={inputRef}
            placeholder="Where is…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
      </div>

      {/* Status chips — mono, uppercase, ink-bordered */}
      <div className="px-4 pt-3 flex gap-1.5">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => setStatus(c.value)}
            className={cn(
              // Filter chips stay pills (the mockup's .fchip is rounded) — only
              // badges and buttons are squared in this language.
              'px-3 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-[0.08em] border transition-colors',
              status === c.value
                ? 'bg-[var(--color-text)] text-[var(--color-bg)] border-[var(--color-text)]'
                : 'border-[var(--color-text)] text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col px-4 pt-4 pb-4">
        {debounced === '' ? (
          <p className="text-sm text-[var(--color-text-muted)] text-center pt-10">
            Type a name — results show where each thing lives.
          </p>
        ) : isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : isError ? (
          // A failed request must never masquerade as "you don't own that" —
          // on the app's #1 surface that is a lie with consequences.
          <div className="flex flex-col items-center gap-2 pt-10">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Search didn't go through — check your connection.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : results && results.length > 0 ? (
          split ? (
            <SplitView
              list={
                <>
                  <ColHead>{results.length} result{results.length === 1 ? '' : 's'}</ColHead>
                  {results.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'rounded-[var(--radius-sm)]',
                        selectedId === item.id && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
                      )}
                    >
                      <ItemCard item={item} onSelect={() => select(item.id)} />
                    </div>
                  ))}
                </>
              }
              detail={<ItemPreview itemId={selectedId} />}
            />
          ) : (
            <>
              <ColHead>{results.length} result{results.length === 1 ? '' : 's'}</ColHead>
              {results.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </>
          )
        ) : (
          <p className="text-sm text-[var(--color-text-muted)] text-center pt-10">
            Nothing matches “{debounced}”
            {status ? ' with that status — try All.' : '.'}
          </p>
        )}
      </div>
    </div>
  );
}

export default SearchPage;
