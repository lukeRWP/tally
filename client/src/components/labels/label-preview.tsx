import type { LabelPreset } from '@/hooks/use-labels';

interface LabelPreviewProps {
  entity: { name: string; qrCode: string; type: string; breadcrumb?: string; parentZone?: string | null };
  qrImageUrl: string;
  preset: LabelPreset;
}

// Aspect ratios mirror the server PRESETS (2:1, 1:1, 2:3). Rendered small for the dialog.
const RATIO: Record<LabelPreset, { w: number; h: number }> = {
  small: { w: 220, h: 110 }, medium: { w: 200, h: 200 }, large: { w: 160, h: 240 }, sheet: { w: 200, h: 120 },
};

export function LabelPreview({ entity, qrImageUrl, preset }: LabelPreviewProps) {
  const dims = RATIO[preset];
  const banner = (preset === 'medium' || preset === 'large') && entity.parentZone ? entity.parentZone : null;
  return (
    <div className="mx-auto bg-white text-black rounded-[3px] border border-[var(--color-border)] overflow-hidden flex shadow-sm"
      style={{ width: dims.w, height: dims.h }}>
      {banner && (
        <div className="bg-black text-white flex items-center justify-center" style={{ width: 22 }}>
          <span className="font-bold uppercase tracking-wider" style={{ transform: 'rotate(-90deg)', whiteSpace: 'nowrap', fontSize: 11 }}>{banner}</span>
        </div>
      )}
      <div className="flex-1 min-w-0 p-2 flex flex-col gap-1.5">
        <span className="bg-black text-white font-extrabold rounded-[3px] px-1.5 py-1 leading-tight truncate"
          style={{ fontSize: preset === 'small' ? 11 : 13 }}>{entity.name}</span>
        <div className="flex-1 flex items-center justify-center">
          <img src={qrImageUrl} alt={`QR for ${entity.name}`}
            style={{ width: preset === 'large' ? 44 : 72, height: preset === 'large' ? 44 : 72 }} className="bg-white" />
        </div>
        <span className="font-mono text-black leading-tight truncate" style={{ fontSize: 9 }}>{entity.qrCode}</span>
        {preset === 'large' && <span className="text-black leading-tight" style={{ fontSize: 9 }}>+ contents list…</span>}
      </div>
    </div>
  );
}
