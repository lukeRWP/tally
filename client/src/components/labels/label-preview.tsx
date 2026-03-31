interface LabelPreviewProps {
  entity: {
    name: string;
    qrCode: string;
    type: string;
    breadcrumb?: string;
  };
  qrImageUrl: string;
}

export function LabelPreview({ entity, qrImageUrl }: LabelPreviewProps) {
  return (
    <div
      className="flex items-center gap-3 border border-[var(--color-border)] rounded-[var(--radius-md)] p-2 bg-[var(--color-elevated)] max-w-full"
    >
      {/* QR Code */}
      <img
        src={qrImageUrl}
        alt={`QR code for ${entity.name}`}
        width={80}
        height={80}
        className="rounded-[var(--radius-sm)] flex-shrink-0 bg-white"
      />

      {/* Label text */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-bold text-[var(--color-text)] leading-tight truncate">
          {entity.name}
        </span>
        <span className="text-[10px] font-mono text-[var(--color-text-muted)] leading-tight">
          {entity.qrCode}
        </span>
        {entity.breadcrumb && (
          <span className="text-[10px] text-[var(--color-text-muted)] leading-tight truncate">
            {entity.breadcrumb}
          </span>
        )}
      </div>
    </div>
  );
}
