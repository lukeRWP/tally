import * as React from 'react';
import { Link } from 'react-router-dom';
import { Printer as PrinterIcon, Trash2, RotateCw, Send, X, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { useProperties } from '@/hooks/use-inventory';
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

// Terminal jobs are history; the rest are the queue you're watching.
const LIVE = ['queued', 'held', 'claimed'];

function statusLabel(job: PrintJob) {
  if (job.status === 'held') return `waiting for ${job.preset} roll`;
  if (job.status === 'claimed') return 'printing…';
  return job.status;
}

export function PrintQueuePage() {
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

  const [sending, setSending] = React.useState(false);
  const [failedKeys, setFailedKeys] = React.useState<string[]>([]);
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

  async function handlePrintAll() {
    const groups = groupIntoJobs(staged);
    if (!groups.length) return;
    setSending(true);

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
      } catch (err) {
        failedKeys.push(...g.keys);
        if (!firstError) firstError = err instanceof Error ? err.message : 'Send failed';
      }
    }

    if (sentKeys.length) removeStagedMany(sentKeys);
    setFailedKeys(failedKeys);
    setSending(false);

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
      <h1 className="text-lg font-semibold text-[var(--color-text)]">Print</h1>

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
              <span className="text-sm font-medium">{printer.name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                problem ? 'bg-[var(--color-red-bg)] text-[var(--color-red)]'
                : online ? 'bg-[var(--color-green-bg)] text-[var(--color-green)]'
                : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]'}`}>
                {problem ?? (online ? 'Online' : 'Offline')}
              </span>
            </div>
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Loaded roll</p>
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
          <h2 className="text-sm font-semibold text-[var(--color-text)]">
            Ready to print{staged.length > 0 && ` (${staged.length})`}
          </h2>
          {staged.length > 0 && (
            <Button variant="outline" size="sm" className="ml-auto" onClick={clearStaged}>Clear</Button>
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
                <p className="text-xs text-[var(--color-text-muted)]">Set all to</p>
                {ROLLS.map((r) => (
                  <Button key={r.value} size="sm" variant="outline" onClick={() => setAllPresets(r.value)}>
                    {r.label}
                  </Button>
                ))}
              </div>
            )}
            {staged.map((l) => (
              <Card key={l.key} className={`p-2.5 flex items-center gap-2 ${
                failedKeys.includes(l.key) ? 'border-[var(--color-red)]' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{l.name}</p>
                  <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{l.qrCode}</p>
                </div>
                <div className="flex gap-1">
                  {ROLLS.map((r) => {
                    // `large` is a contents manifest — never offered for an item.
                    if (r.value === 'large' && l.entityType === 'item') return null;
                    return (
                      <Button key={r.value} size="sm"
                        variant={l.preset === r.value ? 'default' : 'outline'}
                        onClick={() => setPreset(l.key, r.value)}>
                        {r.label}
                      </Button>
                    );
                  })}
                </div>
                <Button variant="outline" size="sm" onClick={() => removeStaged(l.key)}>
                  <X className="w-3 h-3" />
                </Button>
              </Card>
            ))}

            <Button className="mt-1" onClick={handlePrintAll} disabled={sending || !printer}>
              <Send className="w-4 h-4" />
              {sending ? 'Sending…'
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

      {/* ── Live queue ──────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">
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
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Recent</h2>
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
    </div>
  );
}

export default PrintQueuePage;
