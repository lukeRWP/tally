import * as React from 'react';
import { Printer, ListPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LabelPreview } from './label-preview';
import { useGenerateLabels, useQrImageUrl, type LabelPreset } from '@/hooks/use-labels';
import { usePrinters, useCreatePrintJob, type PrintablePreset } from '@/hooks/use-print';
import { toast } from '@/components/ui/toast';
import { usePrintQueueStore } from '@/store/print-queue-store';

interface LabelEntity {
  id: number;
  name: string;
  qrCode: string;
  type: string;
  breadcrumb?: string;
  // Optional explicit override for the printed banner's parent-zone text.
  // Callers don't need to pass this — LabelPreview derives it from
  // `breadcrumb` when omitted — but it's here so one can later.
  parentZone?: string | null;
}

const PROBLEM_TEXT: Record<string, string> = {
  'media-empty': 'out of labels',
  'cover-open': 'cover open',
  'media-jam': 'jammed',
  offline: 'offline',
};

interface LabelPrintDialogProps {
  entities: LabelEntity[];
  entityType: 'item' | 'container' | 'area';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId?: number;
}

export function LabelPrintDialog({ entities, entityType, isOpen, onOpenChange, propertyId }: LabelPrintDialogProps) {
  const [preset, setPreset] = React.useState<LabelPreset>(entityType === 'item' ? 'small' : 'medium');
  const generateLabels = useGenerateLabels();
  React.useEffect(() => { if (!isOpen) generateLabels.reset(); }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: printers } = usePrinters(isOpen ? propertyId : undefined);
  const printer = printers?.[0];
  const createPrintJob = useCreatePrintJob();

  const isPrintable = preset !== 'sheet';
  const online = !!printer?.lastSeenAt &&
    Date.now() - new Date(printer.lastSeenAt).getTime() < 60_000;
  const problem = printer && printer.printerState === 'stopped'
    ? (printer.printerStateReasons[0] ?? 'stopped')
    : null;
  const rollMatches = printer?.loadedMedia === preset;

  const stageLabels = usePrintQueueStore((st) => st.add);
  // Reactive: subscribes to the staged list, so reopening the dialog after
  // queueing shows "In queue" instead of silently re-offering the add.
  const alreadyStaged = usePrintQueueStore(
    (st) => entities.length === 1 && st.has(entityType, entities[0].id),
  );

  function handleAddToQueue() {
    // Staged locally — nothing reaches tally until you print the batch from
    // the Print page, so this works fine mid-walk with patchy wifi.
    for (const e of entities) {
      stageLabels({
        id: e.id,
        entityType: entityType,
        name: e.name,
        qrCode: e.qrCode,
        propertyId,
        preset: preset as PrintablePreset,
      });
    }
    toast(entities.length === 1
      ? `Added to the print queue`
      : `Added ${entities.length} labels to the print queue`);
    onOpenChange(false);
  }

  function handlePrint() {
    createPrintJob.mutate(
      { entityType, entityIds: entities.map((e) => e.id), preset: preset as PrintablePreset, propertyId },
      {
        onSuccess: (res) => toast(res.status === 'held'
          ? `Queued — will print when you load the ${preset} roll`
          : `Printing ${entities.length} label${entities.length === 1 ? '' : 's'}`),
        onError: (err) => toast(err instanceof Error ? err.message : 'Failed to queue the print job'),
      },
    );
  }

  // `large` is only offered when a single non-item entity is selected (a manifest
  // is per-container/area). If the selection changes underneath a `large` choice,
  // reset to a valid default before generating.
  React.useEffect(() => {
    if (preset === 'large' && (entityType === 'item' || entities.length !== 1)) {
      setPreset(entityType === 'item' ? 'small' : 'medium');
    }
  }, [entityType, entities.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstEntity = entities[0];
  const qrImageUrl = useQrImageUrl(firstEntity?.qrCode ?? '');

  function handleGenerate() {
    if (entities.length === 0) return;
    generateLabels.mutate(
      { entityType, entityIds: entities.map((e) => e.id), preset },
      { onSuccess: () => toast('PDF downloaded'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Failed to generate labels') },
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm w-full mx-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="w-4 h-4" />
            Print Labels
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Count */}
          <p className="text-sm text-[var(--color-text-secondary)]">
            Generating{' '}
            <span className="font-semibold text-[var(--color-text)]">{entities.length}</span>{' '}
            {entities.length === 1 ? 'label' : 'labels'}
          </p>

          {firstEntity && (
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Preview</p>
              <LabelPreview entity={firstEntity} qrImageUrl={qrImageUrl} preset={preset} />
              {entities.length > 1 && preset !== 'large' && (
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">+ {entities.length - 1} more</p>
              )}
            </div>
          )}

          <div>
            <p className="text-xs text-[var(--color-text-muted)] mb-2">Size</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={preset === 'small' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('small')}>Small · 2×1</Button>
              <Button variant={preset === 'medium' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('medium')}>Medium · 3×3</Button>
              {entityType !== 'item' && entities.length === 1 && (
                <Button variant={preset === 'large' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('large')}>Large · 4×6 list</Button>
              )}
              <Button variant={preset === 'sheet' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('sheet')}>Avery sheet</Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isPrintable && (
            <Button variant="outline" size="sm" onClick={handleAddToQueue} disabled={alreadyStaged}>
              <ListPlus className="w-3.5 h-3.5" />
              {alreadyStaged ? 'In queue' : 'Add to queue'}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={generateLabels.isPending || entities.length === 0}
          >
            {generateLabels.isPending ? 'Generating…' : 'Generate'}
          </Button>
          {printer && isPrintable && (
            <Button
              size="sm"
              onClick={handlePrint}
              disabled={createPrintJob.isPending || !online || !!problem}
              title={
                problem ? `Printer: ${PROBLEM_TEXT[problem] ?? problem}`
                : !online ? 'Printer offline'
                : undefined
              }
            >
              <Printer className="w-3.5 h-3.5" />
              {problem ? `Printer: ${PROBLEM_TEXT[problem] ?? problem}`
                : !online ? 'Printer offline'
                : rollMatches ? 'Send to printer'
                : `Queue for ${preset} roll`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
