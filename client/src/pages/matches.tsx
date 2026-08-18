import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Package, PackageSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { TitleBar } from '@/components/ui/title-bar';
import { RuledRow } from '@/components/ui/ruled-row';
import { SplitView, SplitEmpty } from '@/components/layout/split-view';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { useProperties } from '@/hooks/use-inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
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

  function handlePick(index: number) {
    if (!current) return;
    resolve.mutate({ id: current.id, candidateIndex: index }, {
      onSuccess: (res) => {
        select(null);
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
        if (err instanceof ApiError && err.status === 409) select(null);
        toast(err instanceof Error ? err.message : 'Could not resolve that match');
      },
    });
  }

  function handleDismiss() {
    if (!current) return;
    resolve.mutate({ id: current.id, dismiss: true }, {
      onSuccess: () => { select(null); toast('Dismissed'); },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) select(null);
        toast(err instanceof Error ? err.message : 'Could not dismiss that match');
      },
    });
  }

  const loading = isLoading || !propertyId;

  const list = (
    <div>
      <ColHead>{rows.length} awaiting a product</ColHead>
      {rows.map((m) => (
        <div
          key={m.id}
          className={cn(
            'rounded-[var(--radius-sm)]',
            split && selectedId === m.id && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
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
      <h1><TitleBar>Matches</TitleBar></h1>

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
