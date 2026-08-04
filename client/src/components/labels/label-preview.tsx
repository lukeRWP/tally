import type { LabelPreset } from '@/hooks/use-labels';

interface LabelPreviewProps {
  entity: { name: string; qrCode: string; breadcrumb?: string; parentZone?: string | null };
  qrImageUrl: string;
  preset: LabelPreset;
}

// Aspect ratios mirror the server PRESETS (2:1, 1:1, 2:3). Rendered small for the dialog.
const RATIO: Record<LabelPreset, { w: number; h: number }> = {
  small: { w: 220, h: 110 }, medium: { w: 200, h: 200 }, large: { w: 160, h: 240 }, sheet: { w: 200, h: 120 },
};

// A few representative rows to illustrate the manifest table the `large`
// preset prints (see labels.service.js `_drawManifest`) — not real data.
const SAMPLE_ROWS = [
  { name: 'Winter coats', qty: 4 },
  { name: 'Extension cords', qty: 6 },
  { name: 'Photo albums', qty: 12 },
];

export function LabelPreview({ entity, qrImageUrl, preset }: LabelPreviewProps) {
  const dims = RATIO[preset];
  // The rotated left banner shows the entity's "parent zone" (the Area for a
  // container, the Property for an area — see labels.service.js
  // `getEntityData`). Callers don't wire up a dedicated `parentZone` field
  // today, but every caller already passes a `' > '`-joined `breadcrumb`
  // whose LAST segment is exactly that parent zone. Prefer an explicit
  // `parentZone` if a caller ever supplies one; otherwise derive it so the
  // preview isn't misleadingly blank where the printed label always has it.
  const zone = entity.parentZone ?? entity.breadcrumb?.split('>').map((s) => s.trim()).filter(Boolean).pop() ?? null;
  const banner = (preset === 'medium' || preset === 'large') ? zone : null;
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
        {preset === 'large' && (
          <div className="flex flex-col shrink-0">
            <div className="flex justify-between text-black/50 font-mono uppercase" style={{ fontSize: 6, letterSpacing: 0.5 }}>
              <span>Contents</span>
              <span>Qty</span>
            </div>
            {SAMPLE_ROWS.map((row, i) => (
              <div key={row.name} className="flex justify-between px-0.5" style={{ backgroundColor: i % 2 === 1 ? 'rgba(0,0,0,0.06)' : undefined }}>
                <span className="text-black leading-tight truncate" style={{ fontSize: 7 }}>{row.name}</span>
                <span className="font-mono text-black leading-tight" style={{ fontSize: 7 }}>{row.qty}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
