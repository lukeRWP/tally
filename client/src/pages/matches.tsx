import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ExternalLink, Package, PackageSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColHead } from '@/components/ui/col-head';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { TitleBar } from '@/components/ui/title-bar';
import { RuledRow } from '@/components/ui/ruled-row';
import { SplitView, SplitEmpty } from '@/components/layout/split-view';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { useProperties } from '@/hooks/use-inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav, useNavScrollIntoView } from '@/hooks/use-keyboard-nav';
import { cn, safeExternalUrl } from '@/lib/utils';
import {
  useMatches, useResolveMatch,
  type MatchCandidate, type MatchStatus, type ProductMatch,
} from '@/hooks/use-matches';

/**
 * The worklist behind deferred product selection.
 *
 * Capture, standing up, only ever names an item roughly and queues a
 * background search. This is the desk surface where that search gets turned
 * into a real catalog product — one item at a time, candidates side by side.
 */

/**
 * Where the panel should land after a row resolves or gets dismissed (#228).
 *
 * "Pending" in the task brief means `ready` here — resolve/dismiss can only
 * ever fire against a `ready` row (that's the only status whose panel renders
 * "Use this" / "None of these"; queued/searching have no action yet and
 * none/failed only link out). Scans forward from the just-acted-on row's
 * current position in `rows`, wraps once, and always excludes that row's own
 * id — it may still be sitting in `rows` marked `ready` at the moment this
 * runs (the invalidation-driven refetch hasn't landed yet), and selecting it
 * again would reopen the panel we just cleared.
 */
export function nextPendingAfter(rows: ProductMatch[], id: number): number | null {
  const n = rows.length;
  if (n === 0) return null;
  const idx = rows.findIndex((r) => r.id === id);
  const start = idx === -1 ? 0 : idx + 1;
  for (let offset = 0; offset < n; offset++) {
    const row = rows[(start + offset) % n];
    if (row.id !== id && row.status === 'ready') return row.id;
  }
  return null;
}

function StatusBadge({ status, count }: { status: MatchStatus; count: number }) {
  switch (status) {
    case 'queued':
    case 'searching':
      return <Badge variant="default">Looking…</Badge>;
    case 'ready':
      return <Badge variant="success">{count} found</Badge>;
    case 'none':
      return <Badge variant="warning">No match</Badge>;
    case 'failed':
      return <Badge variant="danger">Couldn't look up</Badge>;
  }
}

function CandidateCard({ candidate, onPick, disabled }: {
  candidate: MatchCandidate;
  onPick: () => void;
  disabled: boolean;
}) {
  const link = safeExternalUrl(candidate.sourceUrl);
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-elevated)]">
          {candidate.imageUrl ? (
            <img src={candidate.imageUrl} alt={candidate.name} className="h-16 w-16 object-cover" />
          ) : (
            <Package className="h-6 w-6 text-[var(--color-text-muted)]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--color-text)]">{candidate.name}</p>
          {(candidate.brand || candidate.model) && (
            <p className="truncate text-xs text-[var(--color-text-secondary)]">
              {[candidate.brand, candidate.model].filter(Boolean).join(' · ')}
            </p>
          )}
          {candidate.upc && (
            <p className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">{candidate.upc}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-rule)] pt-2">
        <div className="flex min-w-0 items-center gap-2">
          {candidate.priceUsd != null && (
            <span className="text-sm font-semibold text-[var(--color-green)]">
              ${candidate.priceUsd.toFixed(2)}
            </span>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              <span className="truncate">{candidate.sourceDomain}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          )}
        </div>
        <Button size="sm" onClick={onPick} disabled={disabled} className="shrink-0">
          Use this
        </Button>
      </div>
    </Card>
  );
}

function CandidatePanel({ match, onPick, onDismiss, resolving, onBack }: {
  match: ProductMatch;
  onPick: (index: number) => void;
  onDismiss: () => void;
  resolving: boolean;
  /** Present only on phone, where the detail replaces the list. */
  onBack?: () => void;
}) {
  const working = match.status === 'queued' || match.status === 'searching';
  const stuck = match.status === 'none' || match.status === 'failed';

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex w-fit items-center gap-1 rounded-[var(--radius-sm)] px-1 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to list
        </button>
      )}

      <div className="border-b-2 border-[var(--color-text)] pb-2">
        <h2 className="truncate text-base font-bold uppercase tracking-[0.06em]">{match.itemName}</h2>
        <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          {match.containerName}
        </p>
      </div>

      {working && (
        <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
          Still searching — check back in a moment.
        </p>
      )}

      {match.status === 'ready' && (
        <div className="flex flex-col gap-2">
          {match.candidates.map((c, i) => (
            <CandidateCard key={i} candidate={c} onPick={() => onPick(i)} disabled={resolving} />
          ))}
          <Button variant="outline" size="sm" onClick={onDismiss} disabled={resolving}>
            None of these
          </Button>
        </div>
      )}

      {stuck && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-text-secondary)]">
            {match.status === 'failed' ? "Couldn't look this up." : 'No match found online.'}
          </p>
          {match.lastError && (
            <p className="break-words font-mono text-[11px] text-[var(--color-red)]">{match.lastError}</p>
          )}
          <div className="flex gap-4">
            <Link to="/capture" className="text-sm text-[var(--color-primary)] underline">
              Scan barcode
            </Link>
            <Link to="/search" className="text-sm text-[var(--color-primary)] underline">
              Search manually
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function MatchesPage() {
  // Above every early return — hooks must run on each render.
  const split = useLayoutMode() === 'sidebar';
  const { data: properties } = useProperties();
  const propertyId = properties?.[0]?.id;
  const { data: matches, isLoading } = useMatches(propertyId);
  const [searchParams, setSearchParams] = useSearchParams();
  const resolve = useResolveMatch(propertyId);

  // Selection lives in the URL, exactly like search.tsx's `sel` param: browser
  // back works, a refresh keeps the pane you were on, and a link to one match
  // is shareable. `select` MERGES into the existing params rather than
  // rebuilding the query string from scratch — search.tsx's own first draft
  // reconstructed it from a couple of known params and silently dropped every
  // other one that happened to be in the URL.
  const selectedId = searchParams.get('sel') ? Number(searchParams.get('sel')) : null;
  const select = React.useCallback((id: number | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id == null) next.delete('sel'); else next.set('sel', String(id));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const rows = matches ?? [];
  const current = rows.find((m) => m.id === selectedId) ?? null;

  // handlePick/handleDismiss's onSuccess callbacks fire asynchronously, and
  // the list polls every 5s while anything is queued/searching — a refetch
  // can land between the click and the mutation settling. nextPendingAfter
  // needs `rows` as they stand AT SUCCESS TIME, not the array closed over
  // when the handler was defined, so it reads this ref instead of `rows`.
  const rowsRef = React.useRef(rows);
  React.useEffect(() => { rowsRef.current = rows; }, [rows]);

  /**
   * The keyboard ring, over ALL rows in visible order — not just `ready` ones,
   * so j/k can survey a whole backlog including the stuck rows a click would
   * otherwise be the only way to reach.
   *
   * Unlike search.tsx/areas.tsx (where moving the ring IS selecting), Enter is
   * a separate, deliberate step here: opening a row's panel can trigger a
   * resolve, so browsing past several rows with j/k must not fire it along
   * the way. The cursor is tracked BY ID (like home.tsx's ring), not by index
   * — an index synced off `ids` identity would snap back to the selected row
   * every time the 5s poll refetches (any status flip anywhere gives `rows` a
   * new array identity even when its CONTENT is unchanged), silently undoing
   * a mid-browse cursor. Sync effect #1 below fires only when `selectedId`
   * itself changes (Enter, a click, or auto-advance after a resolve/dismiss)
   * — that is what hands the cursor off to `selectedId` as the single source
   * of truth the moment a selection exists, for free. Sync effect #2 handles
   * the one case an id-based cursor still needs reconciling: the highlighted
   * ROW ITSELF disappearing (resolved, dismissed, or removed elsewhere) —
   * falling back to the still-selected row if any, else the first remaining
   * row, else nothing. That also closes the "ghost ring after the last
   * resolve" case: selecting `null` clears the cursor's fallback target, and
   * the next poll that drops the resolved row from `ids` reconciles the rest.
   */
  const ids = React.useMemo(() => rows.map((m) => m.id), [rows]);
  const [highlightedId, setHighlightedId] = React.useState<number | null>(null);

  // #1 — hand off to selectedId, and ONLY on a real selection change.
  React.useEffect(() => {
    if (selectedId != null) setHighlightedId(selectedId);
  }, [selectedId]);

  // #2 — reconcile only when the highlighted row itself is gone; a poll that
  // leaves it in place (even under a brand new `ids` array reference) must
  // not touch the cursor at all.
  React.useEffect(() => {
    if (highlightedId == null || ids.includes(highlightedId)) return;
    setHighlightedId(selectedId ?? (ids.length > 0 ? ids[0] : null));
  }, [ids, highlightedId, selectedId]);

  const moveHighlight = React.useCallback((delta: 1 | -1) => {
    if (ids.length === 0) return;
    const at = highlightedId == null ? -1 : ids.indexOf(highlightedId);
    const next = at === -1
      ? (delta === 1 ? 0 : ids.length - 1)
      : Math.min(ids.length - 1, Math.max(0, at + delta));
    setHighlightedId(ids[next]);
  }, [ids, highlightedId]);
  useKeyboardNav({
    enabled: split,
    onMove: moveHighlight,
    onOpen: () => {
      if (highlightedId == null) return false;
      select(highlightedId);
      return true;
    },
    onEscape: () => { select(null); setHighlightedId(null); },
    // Tab onto a row IS a cursor move (#279). It moves the CURSOR only —
    // `selectedId` (the row whose candidates are open in the pane) stays
    // whatever it was, keeping this page's two distinct markers distinct.
    onFocusRow: (navId) => {
      const n = Number(navId);
      if (Number.isFinite(n) && ids.includes(n)) setHighlightedId(n);
    },
  });
  // Keeps the cursor on screen while browsing a long backlog (#235) — rows
  // below carry the matching data-nav-id. A click-driven hand-off (sync #1)
  // is a no-op here: block 'nearest' moves nothing already visible.
  useNavScrollIntoView(highlightedId);

  const [bulkClearing, setBulkClearing] = React.useState<{ i: number; n: number } | null>(null);
  const [bulkClearOpen, setBulkClearOpen] = React.useState(false);
  const failedRows = rows.filter((r) => r.status === 'none' || r.status === 'failed');

  function handlePick(index: number) {
    if (!current) return;
    const id = current.id;
    resolve.mutate({ id, candidateIndex: index }, {
      onSuccess: (res) => {
        select(nextPendingAfter(rowsRef.current, id));
        if (res?.duplicates?.length) {
          toast(`Linked — you may already have one in ${res.duplicates[0].containerName}`);
        } else {
          toast(`Linked to ${res?.product?.name ?? 'that product'}`);
        }
      },
      onError: (err) => {
        // Someone else already resolved or dismissed this one — the hook has
        // already invalidated the list, so clearing the selection here just
        // moves the panel back to empty in step with the row disappearing,
        // instead of leaving a still-clickable panel for a row that's gone.
        // A 409 means the row went stale, not that work continues, so this
        // stays select(null) rather than auto-advancing over a phantom index.
        if (err instanceof ApiError && err.status === 409) select(null);
        toast(err instanceof Error ? err.message : 'Could not resolve that match');
      },
    });
  }

  function handleDismiss() {
    if (!current) return;
    const id = current.id;
    resolve.mutate({ id, dismiss: true }, {
      onSuccess: () => { select(nextPendingAfter(rowsRef.current, id)); toast('Dismissed'); },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) select(null);
        toast(err instanceof Error ? err.message : 'Could not dismiss that match');
      },
    });
  }

  // Sequential, not Promise.all — these share the same underlying dismiss
  // endpoint the single-row flow uses, and firing them concurrently would
  // just be N races against the same list invalidation. Continue-on-failure
  // (#278), matching container-detail's and recycle-bin's bulk loops: one
  // row's 500 does not strand the rest of the batch. There is nothing to
  // "keep selected" here the way those two do — failedRows is derived
  // straight from `rows`, so a row whose dismiss failed simply never leaves
  // the none/failed set and reappears in it on its own once this snapshot's
  // targets array is done being walked.
  async function handleBulkClear() {
    const targets = failedRows;
    const n = targets.length;
    if (n === 0 || bulkClearing) return;
    setBulkClearing({ i: 0, n });
    let ok = 0;
    let failed = 0;
    for (let idx = 0; idx < targets.length; idx++) {
      try {
        await resolve.mutateAsync({ id: targets[idx].id, dismiss: true });
        ok += 1;
      } catch {
        failed += 1;
      }
      setBulkClearing({ i: idx + 1, n });
    }
    setBulkClearing(null);
    toast(failed ? `Cleared ${ok} · ${failed} failed` : `Cleared ${ok}`);
  }

  const loading = isLoading || !propertyId;

  const list = (
    <div>
      <ColHead>{rows.length} awaiting a product</ColHead>
      {rows.map((m) => (
        <div
          key={m.id}
          data-nav-id={m.id}
          className={cn(
            'rounded-[var(--radius-sm)]',
            // A quiet, persistent marker for the row that's OPEN (its panel is
            // on the right, resolve buttons live) — independent of the ring,
            // so browsing away with j/k never makes the open row invisible.
            split && selectedId === m.id && 'bg-[var(--color-elevated)]',
            // The cursor itself — always shown, coincides with the marker
            // above when the cursor sits on the selected row.
            split && highlightedId === m.id && 'ring-1 ring-[var(--color-text)]',
          )}
        >
          <RuledRow
            title={m.itemName}
            meta={m.containerName}
            trailing={<StatusBadge status={m.status} count={m.candidates.length} />}
            onNavigate={() => select(m.id)}
          />
        </div>
      ))}
    </div>
  );

  const detail = current ? (
    <CandidatePanel
      match={current}
      onPick={handlePick}
      onDismiss={handleDismiss}
      resolving={resolve.isPending}
      onBack={!split ? () => select(null) : undefined}
    />
  ) : (
    <SplitEmpty hint="the list stays put while you look">Pick an item to see its matches.</SplitEmpty>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1><TitleBar>Matches</TitleBar></h1>
        {failedRows.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setBulkClearOpen(true)} disabled={!!bulkClearing}>
            {bulkClearing ? `Clearing… ${bulkClearing.i} of ${bulkClearing.n}` : `Clear ${failedRows.length} failed`}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={bulkClearOpen}
        onOpenChange={(open) => { if (!bulkClearing) setBulkClearOpen(open); }}
        title={`Clear ${failedRows.length} failed lookup${failedRows.length === 1 ? '' : 's'}?`}
        description="They'll leave the worklist; the items keep their names."
        destructive
        confirmLabel="Clear"
        isPending={!!bulkClearing}
        onConfirm={() => { setBulkClearOpen(false); handleBulkClear(); }}
      />

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10">
          <PackageSearch className="h-6 w-6 text-[var(--color-text-muted)]" />
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Nothing waiting
          </p>
          <p className="max-w-xs text-center text-xs text-[var(--color-text-muted)]">
            Items a photo identified with a confident brand show up here to pick their product.
          </p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        split ? <SplitView list={list} detail={detail} /> : (current ? detail : list)
      )}
    </div>
  );
}

export default MatchesPage;
