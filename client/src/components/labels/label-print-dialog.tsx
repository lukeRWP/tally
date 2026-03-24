import * as React from 'react';
import { Download, Copy, Printer } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LabelPreview } from './label-preview';
import { useGenerateLabels, useQrImageUrl } from '@/hooks/use-labels';
import { toast } from '@/components/ui/toast';

interface LabelEntity {
  id: number;
  name: string;
  qrCode: string;
  type: string;
  breadcrumb?: string;
}

interface LabelPrintDialogProps {
  entities: LabelEntity[];
  entityType: 'item' | 'container' | 'area';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

function FirstEntityQrUrl({ qrCode }: { qrCode: string }) {
  return useQrImageUrl(qrCode);
}

export function LabelPrintDialog({ entities, entityType, isOpen, onOpenChange }: LabelPrintDialogProps) {
  const [format, setFormat] = React.useState<'pdf' | 'zpl'>('pdf');
  const [zplOutput, setZplOutput] = React.useState<string | null>(null);

  const generateLabels = useGenerateLabels();

  // Reset ZPL output when dialog closes or format changes
  React.useEffect(() => {
    if (!isOpen) {
      setZplOutput(null);
      generateLabels.reset();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setZplOutput(null);
    generateLabels.reset();
  }, [format]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstEntity = entities[0];
  const qrImageUrl = firstEntity ? `/api/labels/_x_/qr/${firstEntity.qrCode}` : '';

  function handleGenerate() {
    if (entities.length === 0) return;

    generateLabels.mutate(
      {
        entityType,
        entityIds: entities.map((e) => e.id),
        format,
      },
      {
        onSuccess: (result) => {
          if (result.format === 'pdf') {
            toast('PDF downloaded');
          } else if (result.format === 'zpl') {
            setZplOutput(result.zpl);
          }
        },
        onError: (err) => {
          toast(err instanceof Error ? err.message : 'Failed to generate labels');
        },
      },
    );
  }

  async function handleCopyZpl() {
    if (!zplOutput) return;
    try {
      await navigator.clipboard.writeText(zplOutput);
      toast('ZPL copied to clipboard');
    } catch {
      toast('Failed to copy to clipboard');
    }
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

          {/* Preview */}
          {firstEntity && (
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Preview</p>
              <LabelPreview entity={firstEntity} qrImageUrl={qrImageUrl} />
              {entities.length > 1 && (
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                  + {entities.length - 1} more
                </p>
              )}
            </div>
          )}

          {/* Format selector */}
          <div>
            <p className="text-xs text-[var(--color-text-muted)] mb-2">Format</p>
            <div className="flex gap-2">
              <Button
                variant={format === 'pdf' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setFormat('pdf')}
              >
                <Download className="w-3.5 h-3.5" />
                PDF (Sheet Printer)
              </Button>
              <Button
                variant={format === 'zpl' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setFormat('zpl')}
              >
                <Printer className="w-3.5 h-3.5" />
                ZPL (Thermal)
              </Button>
            </div>
          </div>

          {/* ZPL output */}
          {zplOutput && format === 'zpl' && (
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">ZPL Output</p>
              <textarea
                readOnly
                value={zplOutput}
                rows={6}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text)] font-mono text-[10px] p-2 resize-none focus:outline-none"
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                onClick={handleCopyZpl}
              >
                <Copy className="w-3.5 h-3.5" />
                Copy to Clipboard
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={generateLabels.isPending || entities.length === 0}
          >
            {generateLabels.isPending ? 'Generating…' : 'Generate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
