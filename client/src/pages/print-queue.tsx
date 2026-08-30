import * as React from 'react';
import { Link } from 'react-router';
import { Printer as PrinterIcon, Trash2, RotateCw, Send, X, Inbox, CheckSquare, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { useProperties } from '@/hooks/use-inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { cn } from '@/lib/utils';
import {
  usePrinters, usePrintJobs, useCreatePrintJob, useCancelPrintJob,
  useRetryPrintJob, useSetLoadedMedia, type PrintablePreset, type PrintJob,
} from '@/hooks/use-print';
import { usePrintQueueStore, groupIntoJobs } from '@/store/print-queue-store';

const ROLLS: { value: PrintablePreset; label: string }[] = [
  { value: 'small', label: '2×1' },
  { value: 'medium', label: '3×3' },
  { value: 'large', label: '4×6' },
];

const PROBLEM_TEXT: Record<string, string> = {
  'media-empty': 'Out of labels',
  'cover-open': 'Cover open',
  'media-jam': 'Jammed',
  offline: 'Offline',
};

// Same idiom as recent-activity / notification-list. The <60s branch never
// shows here — inside 60s the printer still counts as online.
function relativeTime(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// "Offline" alone hides how long the agent has been gone (#204).
function offlineLabel(lastSeenAt: string | null): string {
  return lastSeenAt ? `Offline · last seen ${relativeTime(lastSeenAt)}` : 'Offline';
}

// Terminal jobs are history; the rest are the queue you're watching.
const LIVE = ['queued', 'held', 'claimed'];

function statusLabel(job: PrintJob) {
  if (job.status === 'held') return `waiting for ${job.preset} roll`;
  if (job.status === 'claimed') return 'printing…';
  return job.status;
}

export function PrintQueuePage() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const { data: properties } = useProperties();
  const propertyId = properties?.[0]?.id;

  const { data: printers, isLoading: printersLoading, isError: printersError } = usePrinters(propertyId);
  const { data: jobs } = usePrintJobs(propertyId);
  const createJob = useCreatePrintJob();
  const cancelJob = useCancelPrintJob(propertyId);
  const retryJob = useRetryPrintJob(propertyId);
  const setLoadedMedia = useSetLoadedMedia(propertyId);

  const staged = usePrintQueueStore((s) => s.staged);
  const removeStaged = usePrintQueueStore((s) => s.remove);
  const clearStaged = usePrintQueueStore((s) => s.clear);
  const removeStagedMany = usePrintQueueStore((s) => s.removeMany);
  const setPreset = usePrintQueueStore((s) => s.setPreset);
  const setAllPresets = usePrintQueueStore((s) => s.setAllPresets);
  const setPresetMany = usePrintQueueStore((s) => s.setPresetMany);

  // `sendProgress` doubles as the "is a send in flight" flag (`sending`
  // below) AND the `N of M` counter the other three batch surfaces all
  // show (`matches.tsx`'s `Clearing…`, container-detail's `Deleting…`,
  // recycle-bin's `Restoring…`) — this page rendered a bare "Sending…"
  // with nothing else in the DOM to say how far along it was (#281).
  const [sendProgress, setSendProgress] = React.useState<{ i: number; n: number } | null>(null);
  const [failedKeys, setFailedKeys] = React.useState<string[]>([]);
  // Select mode over the staged batch — the fourth "process a pile of
  // things" surface, brought into the same dialect as container-detail's
  // select mode and recycle-bin-list's: a toggle, checkboxes, and one bulk
  // action (Remove). Trimming a staged batch one X-click at a time was the
  // single biggest defect on this page (#281).
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const sending = !!sendProgress;
  const printer = printers?.[0];

  const online = !!printer?.lastSeenAt && Date.now() - new Date(printer.lastSeenAt).getTime() < 60_000;
  const problem = printer?.printerState === 'stopped'
    ? PROBLEM_TEXT[printer.printerStateReasons[0]] ?? 'Stopped'
    : null;

  // A job queues fine whether or not the Pi is awake — the agent picks it up on
  // its next poll. So offline never blocks sending; it only changes the wording.
  // Blocking here would defeat the whole point of staging a batch while walking
  // around, and a homelab printer being off overnight is the normal case.
  const printerReady = !!printer && online && !problem;

  const live = (jobs ?? []).filter((j) => LIVE.includes(j.status));
  const recent = (jobs ?? []).filter((j) => !LIVE.includes(j.status)).slice(0, 10);

  // A background change to `staged` (Clear, Remove failed, a per-row X) can
  // drop rows out from under an open selection — prune ghosts so "N
  // selected" only ever counts rows still here. Mirrors recycle-bin-list's
  // and container-detail's identical effect.
  React.useEffect(() => {
    if (!selecting) return;
    const valid = new Set(staged.map((l) => l.key));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [selecting, staged]);

  // Nothing left to select once the batch empties out from under it (e.g.
  // Clear, or a bulk Remove that took the last rows) — an empty select mode
  // has no reason to stay open.
  React.useEffect(() => {
    if (selecting && staged.length === 0) exitSelectMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting, staged.length]);

  function exitSelectMode() {
    setSelecting(false);
    setSelected(new Set());
  }

  function toggleSelected(key: string) {
    // Inert while a send is in flight (#281's input-freeze discipline) — a
    // click here would mutate `selected` only for handlePrintAll's own
    // `removeStagedMany(sentKeys)` to silently prune it moments later.
    if (sending) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleSelectAll() {
    if (sending) return;
    setSelected(new Set(staged.map((l) => l.key)));
  }

  // Purely local — unstaging is a zustand write, not a network call, so
  // there is nothing to run a progress loop over. It reads as instant
  // because it is.
  function handleBulkRemove() {
    const keys = [...selected];
    if (keys.length === 0) return;
    removeStagedMany(keys);
    exitSelectMode();
    toast(`Removed ${keys.length}`);
  }

  // What the select-mode bar's own roll setter scopes to — a retarget of
  // PART of the batch, unlike "Set all to" above the list (which is
  // unscoped and stays exactly as it was). Per-row preset buttons are
  // hidden while selecting (#281), so without this there was no way at all
  // to retarget a subset once you'd started trimming it.
  const selectedLabels = staged.filter((l) => selected.has(l.key));

  function handleBulkPreset(preset: PrintablePreset) {
    const keys = [...selected];
    if (keys.length === 0) return;
    setPresetMany(keys, preset);
    if (preset === 'large') {
      const skipped = selectedLabels.filter((l) => l.entityType === 'item').length;
      if (skipped > 0) toast(`Items keep their size — ${selectedLabels.length - skipped} set to 4×6`);
    }
  }

  async function handlePrintAll() {
    const groups = groupIntoJobs(staged);
    if (!groups.length) return;
    const total = staged.length;
    setSendProgress({ i: 0, n: total });

    let queued = 0;
    let held = 0;
    const sentKeys: string[] = [];
    const failedKeys: string[] = [];
    let firstError = '';

    // One request per group — the API takes a single entityType + preset + property
    // and caps ids per job. Sequential so a partial failure stays comprehensible.
    for (const g of groups) {
      try {
        const res = await createJob.mutateAsync({
          entityType: g.entityType,
          entityIds: g.entityIds,
          preset: g.preset,
          propertyId: g.propertyId ?? propertyId,
        });
        // Track exactly which labels landed. The server inserts unconditionally,
        // so re-sending a group that already succeeded prints it a second time —
        // real wasted labels. Only these keys get un-staged.
        sentKeys.push(...g.keys);
        if (res?.status === 'held') held += g.entityIds.length;
        else queued += g.entityIds.length;
        // Group-level loop: a whole group lands (or fails) in one request,
        // so the counter jumps by the group's size rather than ticking one
        // at a time — still a truthful `i of n` against the label count.
        setSendProgress({ i: sentKeys.length + failedKeys.length, n: total });
      } catch (err) {
        // The server refuses a batch if ANY id fails to resolve (deleted since
        // staging), so one stale row 404s a whole 50-label group. Isolate by
        // re-sending per entity: the healthy rest prints, only the stale rows
        // stay red. Bail after 3 straight failures with no success — that's a
        // systemic error (network, auth), not a stale row, and not worth
        // hammering the API once per label.
        if (g.entityIds.length > 1) {
          let isolated = 0;
          for (let i = 0; i < g.entityIds.length; i++) {
            if (i >= 3 && isolated === 0) {
              failedKeys.push(...g.keys.slice(i));
              setSendProgress({ i: sentKeys.length + failedKeys.length, n: total });
              break;
            }
            try {
              const res = await createJob.mutateAsync({
                entityType: g.entityType,
                entityIds: [g.entityIds[i]],
                preset: g.preset,
                propertyId: g.propertyId ?? propertyId,
              });
              sentKeys.push(g.keys[i]);
              isolated += 1;
              if (res?.status === 'held') held += 1;
              else queued += 1;
            } catch (err2) {
              failedKeys.push(g.keys[i]);
              if (!firstError) firstError = err2 instanceof Error ? err2.message : 'Send failed';
            }
            // Isolation loop: this is the branch the issue calls out — up to
            // 50 sequential requests behind a bare "Sending…" with no way to
            // tell it apart from a hang. Ticks once per entity, same shape.
            setSendProgress({ i: sentKeys.length + failedKeys.length, n: total });
          }
        } else {
          failedKeys.push(...g.keys);
          if (!firstError) firstError = err instanceof Error ? err.message : 'Send failed';
          setSendProgress({ i: sentKeys.length + failedKeys.length, n: total });
        }
      }
    }

    if (sentKeys.length) removeStagedMany(sentKeys);
    setFailedKeys(failedKeys);
    setSendProgress(null);

    if (failedKeys.length) {
      toast(
        sentKeys.length
          ? `Sent ${queued + held}; ${failedKeys.length} still staged — ${firstError}`
          : `Nothing sent — ${firstError}`,
      );
      return;
    }
    toast(
      held > 0
        ? `Sent ${queued + held} — ${held} waiting for a different roll`
        : `${printerReady ? 'Printing' : 'Queued'} ${queued} label${queued === 1 ? '' : 's'}`,
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <h1><TitleBar>Print</TitleBar></h1>

      {/* ── Printer ─────────────────────────────────────────────────── */}
      <Card className="p-3">
        {printersLoading || !propertyId ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <PrinterIcon className="w-4 h-4 animate-pulse" />
            <span>Checking for a printer…</span>
          </div>
        ) : printersError ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-red)]">
            <PrinterIcon className="w-4 h-4" />
            <span>Could not load the printer.</span>
          </div>
        ) : !printer ? (
          // Only claim there is no printer once we have actually been told so —
          // otherwise the Settings CTA invites registering a second, invisible
          // agent that would never be picked (the server takes ORDER BY ID LIMIT 1).
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <PrinterIcon className="w-4 h-4" />
            <span>No printer set up.</span>
            <Link to="/settings" className="text-[var(--color-primary)] underline">Add one in Settings</Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <PrinterIcon className="w-4 h-4" />
              <span className="text-sm font-semibold">{printer.name}</span>
              <Badge variant={problem ? 'danger' : online ? 'success' : 'default'}>
                {problem ?? (online ? 'Online' : offlineLabel(printer.lastSeenAt))}
              </Badge>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] mb-1.5">Loaded roll</p>
              <div className="flex gap-2">
                {ROLLS.map((r) => (
                  <Button key={r.value} size="sm"
                    variant={printer.loadedMedia === r.value ? 'default' : 'outline'}
                    onClick={() => setLoadedMedia.mutate({ id: printer.id, loadedMedia: r.value }, {
                      onSuccess: (res) => toast(res.released > 0
                        ? `Released ${res.released} waiting job${res.released === 1 ? '' : 's'}`
                        : 'Loaded roll updated'),
                      onError: (e) => toast(e instanceof Error ? e.message : 'Could not change the loaded roll'),
                    })}>
                    {r.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* ── Staging area ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-text)]">
            Ready to print{staged.length > 0 && ` · ${staged.length}`}
          </h2>
          {staged.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
              {failedKeys.length > 0 && (
                <Button variant="outline" size="sm" disabled={sending}
                  className="text-[var(--color-red)] border-[var(--color-red)]"
                  onClick={() => { removeStagedMany(failedKeys); setFailedKeys([]); }}>
                  Remove failed ({failedKeys.length})
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={sending} onClick={clearStaged}>Clear</Button>
              <Button
                variant={selecting ? 'default' : 'outline'}
                size="sm"
                disabled={sending}
                onClick={() => (selecting ? exitSelectMode() : setSelecting(true))}
              >
                <CheckSquare className="w-4 h-4" />
                Select
              </Button>
            </div>
          )}
        </div>

        {staged.length === 0 ? (
          <Card className="p-6 flex flex-col items-center gap-2 text-center">
            <Inbox className="w-6 h-6 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">Nothing staged yet</p>
            <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
              Open an item, container or area and choose <span className="font-medium">Add to print queue</span> to
              collect labels here, then print them in one go.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* Bulk roll change — a batch staged from "Label all bins" lands on
                one preset; switching fifty rows one-by-one defeats the point. */}
            {staged.length > 1 && (
              <div className="flex items-center gap-1.5 pb-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Set all to</p>
                {ROLLS.map((r) => {
                  // Mirror the per-row rule: a manifest is meaningless for an
                  // item, so an all-item queue never offers 4×6 at all, and a
                  // mixed queue says out loud that items were skipped.
                  if (r.value === 'large' && staged.every((l) => l.entityType === 'item')) return null;
                  return (
                    <Button key={r.value} size="sm" variant="outline" disabled={sending}
                      onClick={() => {
                        setAllPresets(r.value);
                        if (r.value === 'large') {
                          const skipped = staged.filter((l) => l.entityType === 'item').length;
                          if (skipped > 0) toast(`Items keep their size — ${staged.length - skipped} set to 4×6`);
                        }
                      }}>
                      {r.label}
                    </Button>
                  );
                })}
              </div>
            )}
            {/* Two columns at a desk — the same `wide && grid grid-cols-2
                gap-x-6` wrapper container-detail and recycle-bin-list already
                use. A staged card stretched to the full page width put ~850px
                of empty row between a label's name and its own controls,
                50 times over, and made a 50-label batch 3930px tall (#281). */}
            <div className={cn(wide && 'grid grid-cols-2 gap-x-6')}>
              {staged.map((l) => {
                const isSelected = selected.has(l.key);
                return (
                  <Card key={l.key}
                    className={`p-2.5 flex items-center gap-2 ${
                      failedKeys.includes(l.key) ? 'border-[var(--color-red)]' : ''}`}
                    onClick={selecting ? () => toggleSelected(l.key) : undefined}
                    aria-pressed={selecting ? isSelected : undefined}
                    aria-label={selecting ? `Select ${l.name}` : undefined}
                  >
                    {selecting && (
                      <span
                        className={cn(
                          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[2px] border-[1.6px]',
                          isSelected
                            ? 'border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-bg)]'
                            : 'border-[var(--color-text)] text-transparent',
                        )}
                      >
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{l.name}</p>
                      <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{l.qrCode}</p>
                    </div>
                    {/* Hidden while selecting, same as recycle-bin-list's
                        per-row Restore — these are real nested buttons, and
                        the row itself becomes the toggle target, so both
                        firing off one tap would be a second, invisible
                        surprise action. */}
                    {!selecting && (
                      <>
                        <div className="flex gap-1">
                          {ROLLS.map((r) => {
                            // `large` is a contents manifest — never offered for an item.
                            if (r.value === 'large' && l.entityType === 'item') return null;
                            return (
                              <Button key={r.value} size="sm"
                                variant={l.preset === r.value ? 'default' : 'outline'}
                                disabled={sending}
                                onClick={() => setPreset(l.key, r.value)}>
                                {r.label}
                              </Button>
                            );
                          })}
                        </div>
                        <Button variant="outline" size="sm" disabled={sending} onClick={() => removeStaged(l.key)}>
                          <X className="w-3 h-3" />
                        </Button>
                      </>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Live queue ──────────────────────────────────────────────── */}
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-text)] mb-2">
          In the queue{live.length > 0 && ` (${live.length})`}
        </h2>
        {live.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">Nothing waiting to print.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {live.map((j) => (
              <Card key={j.id} className="p-2.5 flex items-center gap-2 text-xs">
                <span className="font-mono">{j.preset}</span>
                <span className="text-[var(--color-text-muted)]">
                  {j.entityIds.length} label{j.entityIds.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto">{statusLabel(j)}</span>
                <Button variant="outline" size="sm" disabled={cancelJob.isPending}
                  onClick={() => cancelJob.mutate(j.id, {
                    onError: (e) => toast(e instanceof Error ? e.message : 'Could not cancel that job'),
                  })}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* ── History ─────────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-text)] mb-2">Recent</h2>
          <div className="flex flex-col gap-1.5">
            {recent.map((j) => (
              <Card key={j.id} className="p-2.5 flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{j.preset}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {j.entityIds.length} label{j.entityIds.length === 1 ? '' : 's'}
                  </span>
                  <span className={`ml-auto ${j.status === 'failed' ? 'text-[var(--color-red)]' : 'text-[var(--color-text-muted)]'}`}>
                    {j.status}
                  </span>
                  {j.status === 'failed' && (
                    <Button variant="outline" size="sm" disabled={retryJob.isPending}
                      onClick={() => retryJob.mutate(j.id, {
                        onError: (e) => toast(e instanceof Error ? e.message : 'Could not retry that job'),
                      })}>
                      <RotateCw className="w-3 h-3" />
                    </Button>
                  )}
                </div>
                {j.status === 'failed' && j.lastError && (
                  <span className="text-[10px] text-[var(--color-red)] break-words">{j.lastError}</span>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Select-mode action bar — same fixed-panel treatment as
          container-detail's and recycle-bin-list's, and mutually exclusive
          with the send bar below (there is nothing to send mid-trim). */}
      {selecting && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[22rem] z-30 bg-[var(--color-card)] border-2 border-[var(--color-text)] rounded-[var(--radius-md)] shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-2">
          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--color-text)] flex-1 min-w-0 truncate tabular-nums">
            {selected.size} selected
          </p>
          <Button variant="ghost" size="sm" onClick={handleSelectAll}>All</Button>
          <Button variant="outline" size="sm" onClick={exitSelectMode}>Cancel</Button>
          {/* The scoped roll setter #281 asked for — "one action (Remove)
              plus the roll setter". "Set all to" above the list is
              unscoped and stays; this is the only way to retarget a
              SUBSET, since per-row preset buttons are hidden while
              selecting. */}
          <div className="flex gap-1">
            {ROLLS.map((r) => {
              if (r.value === 'large' && selected.size > 0 && selectedLabels.every((l) => l.entityType === 'item')) return null;
              return (
                <Button key={r.value} size="sm" variant="outline"
                  disabled={selected.size === 0}
                  onClick={() => handleBulkPreset(r.value)}>
                  {r.label}
                </Button>
              );
            })}
          </div>
          <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={handleBulkRemove}>
            <X className="w-4 h-4" />
            Remove{selected.size > 0 ? ` ${selected.size}` : ''}
          </Button>
        </div>
      )}

      {/* Primary action, pinned — was the last thing in the staged list,
          3.4 screens of scrolling down on a 50-label batch (#281). Every
          sibling batch surface pins its primary action; this now does too. */}
      {!selecting && staged.length > 0 && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[22rem] z-30 bg-[var(--color-card)] border-2 border-[var(--color-text)] rounded-[var(--radius-md)] shadow-lg px-3 py-2.5 flex flex-col gap-1.5">
          <Button className="w-full" onClick={handlePrintAll} disabled={sending || !printer}>
            <Send className="w-4 h-4" />
            {sendProgress ? `Sending… ${sendProgress.i} of ${sendProgress.n}`
              : !printer ? 'No printer set up'
              : `${printerReady ? 'Print' : 'Queue'} ${staged.length} label${staged.length === 1 ? '' : 's'}`}
          </Button>
          {printer && !printerReady && (
            <p className="text-[10px] text-[var(--color-text-muted)] text-center">
              {problem ? `Printer: ${problem}.` : 'Printer is offline.'} Jobs will print when it is back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default PrintQueuePage;
