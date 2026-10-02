import * as React from 'react';
import { Printer as PrinterIcon, Copy, Trash2, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import {
  usePrinters, usePrintJobs, useCreatePrinter, useRevokePrinter,
  useSetLoadedMedia, useCancelPrintJob, useRetryPrintJob,
  useBindServiceAccount, useUnbindServiceAccount, useMovePrinter,
  type PrintablePreset,
} from '@/hooks/use-print';
import { useProperties } from '@/hooks/use-inventory';

// pwiam ids are ULIDs (Crockford base32, no I/L/O/U): 26 characters. Checked
// client-side only as a typo guard — the server is the actual authority
// (print.schema.js's bindServiceAccount).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

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

// Same idiom as recent-activity / notification-list. The <60s branch never
// shows here — inside 60s the printer still counts as online.
function relativeTime(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// "Offline" alone hides how long the agent has been gone (#204) — a Pi that
// missed one poll and one that died last Tuesday read identically.
function offlineLabel(lastSeenAt: string | null): string {
  return lastSeenAt ? `Offline · last seen ${relativeTime(lastSeenAt)}` : 'Offline';
}

export function PrinterSettings({
  propertyId, onMoved,
}: {
  propertyId?: number;
  // Settings follows the printer: after a successful move, the caller
  // re-selects the destination property so the Printing panel doesn't go
  // on showing a printer that just left.
  onMoved?: (propertyId: number) => void;
}) {
  const { data: printers } = usePrinters(propertyId);
  const { data: jobs } = usePrintJobs(propertyId);
  const { data: properties } = useProperties();
  const createPrinter = useCreatePrinter(propertyId);
  const revokePrinter = useRevokePrinter(propertyId);
  const setLoadedMedia = useSetLoadedMedia(propertyId);
  const cancelJob = useCancelPrintJob(propertyId);
  const retryJob = useRetryPrintJob(propertyId);
  const bindServiceAccount = useBindServiceAccount(propertyId);
  const unbindServiceAccount = useUnbindServiceAccount(propertyId);
  const movePrinter = useMovePrinter();

  const [newName, setNewName] = React.useState('');
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const [saId, setSaId] = React.useState('');
  // The agent token is shown exactly once, at registration (see the
  // issuedToken panel below). Removing the printer here has no undo and the
  // same token can't be reissued — a mis-click means re-pairing the Pi with a
  // new credential from scratch (#278).
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const printer = printers?.[0];

  // Only another property the caller owns is a legal destination — an
  // editor/viewer-role property would 404 server-side (moveAgent checks
  // ownership of the destination), so there's no point offering it here.
  const moveDestinations = (properties ?? []).filter((p) => p.role === 'owner' && p.id !== propertyId);
  const [moveTargetId, setMoveTargetId] = React.useState('');
  const [moveOpen, setMoveOpen] = React.useState(false);
  const moveTarget = moveDestinations.find((p) => String(p.id) === moveTargetId);

  function confirmMove() {
    if (!printer || !moveTarget) return;
    movePrinter.mutate({ id: printer.id, toPropertyId: moveTarget.id }, {
      onSuccess: () => {
        setMoveOpen(false);
        toast(`Moved to ${moveTarget.name}`);
        onMoved?.(moveTarget.id);
      },
      onError: (e) => {
        toast(e instanceof Error ? e.message : 'Could not move the printer');
        setMoveOpen(false);
      },
    });
  }

  function confirmRemove() {
    if (!printer) return;
    revokePrinter.mutate(printer.id, {
      onSuccess: () => { setIssuedToken(null); setRemoveOpen(false); },
      onError: (e) => { toast(e instanceof Error ? e.message : 'Could not remove the printer'); setRemoveOpen(false); },
    });
  }

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

  function handlePair() {
    if (!printer) return;
    const id = saId.trim();
    if (!ULID_RE.test(id)) { toast("That doesn't look like a pwiam service-account ID"); return; }
    bindServiceAccount.mutate({ id: printer.id, serviceAccountId: id }, {
      onSuccess: () => { setSaId(''); toast('Paired — put the pwk_ key on the Pi and it will take over'); },
      onError: (e) => toast(e instanceof Error ? e.message : 'Could not pair that service account'),
    });
  }

  function handleUnpair() {
    if (!printer) return;
    unbindServiceAccount.mutate(printer.id, {
      onError: (e) => toast(e instanceof Error ? e.message : 'Could not unpair that service account'),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {!printer && (
        <div className="flex flex-col gap-2">
          <ColHead>Add printer (legacy)</ColHead>
          <div className="flex gap-2">
            <Input placeholder="Printer name (e.g. Garage Pi)" value={newName}
                   onChange={(e) => setNewName(e.target.value)} />
            <Button size="sm" onClick={handleAdd} disabled={createPrinter.isPending}>Add printer</Button>
          </div>
        </div>
      )}

      {issuedToken && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] p-3 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Copy this now — it is shown only once. Put it on the Pi's SD card in{' '}
            <code>/etc/tally-printer/agent.env</code>:
          </p>
          <pre className="text-[10px] font-mono bg-[var(--color-elevated)] p-2 rounded-[var(--radius-sm)] overflow-x-auto">
{`TALLY_TOKEN=${issuedToken}`}
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
            <Badge variant={problem ? 'danger' : online ? 'success' : 'default'}>
              {problem ?? (online ? 'Online' : offlineLabel(printer.lastSeenAt))}
            </Badge>
            <Button variant="outline" size="sm" className="ml-auto"
                    aria-label={`Remove ${printer.name}`}
                    disabled={revokePrinter.isPending}
                    onClick={() => setRemoveOpen(true)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          <ConfirmDialog
            open={removeOpen}
            onOpenChange={(open) => { if (!revokePrinter.isPending) setRemoveOpen(open); }}
            title={`Remove ${printer.name}?`}
            description="This can't be undone. The Pi's saved credential stops working immediately and can't be reissued — re-adding the printer means putting a new one in agent.env on the SD card."
            destructive
            confirmLabel="Remove"
            isPending={revokePrinter.isPending}
            onConfirm={confirmRemove}
          />

          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">Loaded roll</p>
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

          {moveDestinations.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">Move to another property</p>
              <div className="flex gap-2">
                <Select value={moveTargetId} onChange={(e) => setMoveTargetId(e.target.value)}>
                  <option value="">Select a property…</option>
                  {moveDestinations.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
                <Button size="sm" variant="outline" disabled={!moveTargetId || movePrinter.isPending}
                        onClick={() => setMoveOpen(true)}>
                  Move
                </Button>
              </div>
            </div>
          )}

          {moveTarget && (
            <ConfirmDialog
              open={moveOpen}
              onOpenChange={(open) => { if (!movePrinter.isPending) setMoveOpen(open); }}
              title={`Move ${printer.name} to ${moveTarget.name}?`}
              description="The Pi keeps its saved key — nothing to change on the SD card. Jobs waiting here stay with this property; any job mid-print is put back in the queue."
              confirmLabel="Move"
              isPending={movePrinter.isPending}
              onConfirm={confirmMove}
            />
          )}

          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">pwiam service account</p>
            {printer.serviceAccountId ? (
              <div className="flex items-center gap-2">
                <Badge variant="success">Paired</Badge>
                <span className="font-mono text-xs truncate">{printer.serviceAccountId}</span>
                <Button variant="outline" size="sm" className="ml-auto"
                        disabled={unbindServiceAccount.isPending}
                        onClick={handleUnpair}>
                  Unpair
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Mint a <code>pwk_</code> key for this printer in pwiam (kind <code>print-agent</code>), put it on
                  the Pi in <code>/etc/tally-printer/agent.env</code> as <code>TALLY_TOKEN=pwk_…</code>, then paste
                  the service account's ID here to pair it.
                </p>
                <div className="flex gap-2">
                  <Input placeholder="Service account ID (ULID)" value={saId}
                         onChange={(e) => setSaId(e.target.value)} />
                  <Button size="sm" onClick={handlePair} disabled={bindServiceAccount.isPending}>Pair</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!!jobs?.length && (
        <div className="flex flex-col">
          <ColHead>Recent jobs · {jobs.length}</ColHead>
          <div className="flex flex-col">
            {jobs.map((j) => (
              <div key={j.id} className="flex flex-col gap-1 text-xs py-2 border-b border-[var(--color-rule)] last:border-b-0">
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
