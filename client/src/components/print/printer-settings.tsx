import * as React from 'react';
import { Printer as PrinterIcon, Copy, Trash2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  usePrinters, usePrintJobs, useCreatePrinter, useRevokePrinter,
  useSetLoadedMedia, useCancelPrintJob, useRetryPrintJob,
  type PrintablePreset,
} from '@/hooks/use-print';

const ROLLS: { value: PrintablePreset; label: string }[] = [
  { value: 'small', label: 'Small · 2×1' },
  { value: 'medium', label: 'Medium · 3×3' },
  { value: 'large', label: 'Large · 4×6' },
];

const PROBLEM_TEXT: Record<string, string> = {
  'media-empty': 'Out of labels',
  'cover-open': 'Cover open',
  'media-jam': 'Jammed',
  offline: 'Offline',
};

export function PrinterSettings({ propertyId }: { propertyId?: number }) {
  const { data: printers } = usePrinters(propertyId);
  const { data: jobs } = usePrintJobs(propertyId);
  const createPrinter = useCreatePrinter(propertyId);
  const revokePrinter = useRevokePrinter(propertyId);
  const setLoadedMedia = useSetLoadedMedia(propertyId);
  const cancelJob = useCancelPrintJob(propertyId);
  const retryJob = useRetryPrintJob(propertyId);

  const [newName, setNewName] = React.useState('');
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const printer = printers?.[0];

  // Drop the one-time token panel when the selected property changes — it
  // belongs to the property it was issued for, and showing it under another
  // one would hand the operator a config snippet for the wrong printer.
  React.useEffect(() => { setIssuedToken(null); }, [propertyId]);

  const online = !!printer?.lastSeenAt && Date.now() - new Date(printer.lastSeenAt).getTime() < 60_000;
  const problem = printer?.printerState === 'stopped'
    ? PROBLEM_TEXT[printer.printerStateReasons[0]] ?? 'Stopped' : null;

  function handleAdd() {
    if (!newName.trim()) return;
    createPrinter.mutate(newName.trim(), {
      onSuccess: (res) => { setIssuedToken(res.token); setNewName(''); },
      onError: (e) => toast(e instanceof Error ? e.message : 'Could not add the printer'),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {!printer && (
        <div className="flex gap-2">
          <Input placeholder="Printer name (e.g. Garage Pi)" value={newName}
                 onChange={(e) => setNewName(e.target.value)} />
          <Button size="sm" onClick={handleAdd} disabled={createPrinter.isPending}>Add printer</Button>
        </div>
      )}

      {issuedToken && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Copy this now — it is shown only once. Paste it into <code>tally-printer.conf</code> on the SD card:
          </p>
          <pre className="text-[10px] font-mono bg-[var(--color-elevated)] p-2 rounded overflow-x-auto">
{`tally_url   = ${window.location.origin}
agent_token = ${issuedToken}`}
          </pre>
          <Button variant="outline" size="sm" onClick={() => {
            navigator.clipboard.writeText(issuedToken).then(
              () => toast('Token copied'), () => toast('Could not copy'));
          }}>
            <Copy className="w-3.5 h-3.5" /> Copy token
          </Button>
        </div>
      )}

      {printer && (
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
            <Button variant="outline" size="sm" className="ml-auto"
                    disabled={revokePrinter.isPending}
                    onClick={() => revokePrinter.mutate(printer.id, {
                      onSuccess: () => setIssuedToken(null),
                      onError: (e) => toast(e instanceof Error ? e.message : 'Could not remove the printer'),
                    })}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
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

      {!!jobs?.length && (
        <div>
          <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Recent jobs</p>
          <div className="flex flex-col gap-1">
            {jobs.map((j) => (
              <div key={j.id} className="flex flex-col gap-1 text-xs border border-[var(--color-border)] rounded-[var(--radius-md)] px-2 py-1.5">
                <div className="flex items-center gap-2">
                <span className="font-mono">{j.preset}</span>
                <span className="text-[var(--color-text-muted)]">
                  {j.entityIds.length} label{j.entityIds.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto">
                  {j.status === 'held' ? `waiting for ${j.preset} roll` : j.status}
                </span>
                {j.status === 'failed' && (
                  <Button variant="outline" size="sm"
                          disabled={retryJob.isPending}
                          onClick={() => retryJob.mutate(j.id, {
                            onError: (e) => toast(e instanceof Error ? e.message : 'Could not retry that job'),
                          })}>
                    <RotateCw className="w-3 h-3" />
                  </Button>
                )}
                {/* 'claimed' is cancellable server-side too. Without it, a job
                    claimed by a Pi that then went away has no escape in the UI:
                    the stale sweep only runs inside a claim, so if the agent
                    never polls again nothing ever releases it. */}
                {['queued', 'held', 'claimed'].includes(j.status) && (
                  <Button variant="outline" size="sm"
                          disabled={cancelJob.isPending}
                          onClick={() => cancelJob.mutate(j.id, {
                            onError: (e) => toast(e instanceof Error ? e.message : 'Could not cancel that job'),
                          })}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
                </div>
                {/* Visible, not a title tooltip — tooltips never appear on touch,
                    so on a phone the reason a job failed was unreachable. */}
                {j.status === 'failed' && j.lastError && (
                  <span className="text-[10px] text-[var(--color-red)] break-words">{j.lastError}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
