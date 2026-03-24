import { ScanLine } from 'lucide-react';

export function Scan() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-primary-bg)]">
        <ScanLine className="w-8 h-8 text-[var(--color-primary)]" />
      </div>
      <h1 className="text-lg font-bold text-[var(--color-text)]">QR Scanner</h1>
      <p className="text-sm text-[var(--color-text-muted)] text-center max-w-xs">
        Camera scanning coming in Phase 2. You will be able to scan TLY QR codes to quickly navigate to any property, area, container, or item.
      </p>
    </div>
  );
}
