import { useMutation } from '@tanstack/react-query';
import { getCsrfToken } from '@/lib/api';

export type LabelPreset = 'small' | 'medium' | 'large' | 'sheet';

export function useGenerateLabels() {
  return useMutation({
    mutationFn: async ({ entityType, entityIds, preset }:
      { entityType: string; entityIds: number[]; preset: LabelPreset }) => {
      // Raw fetch (not the `api` client) to handle the binary PDF blob; attach
      // CSRF the same way api.request() does.
      const csrf = getCsrfToken();
      const res = await fetch('/api/labels/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: JSON.stringify({ entityType, entityIds, preset }),
      });
      if (!res.ok) {
        let msg = 'Failed to generate labels';
        try { msg = (await res.json()).message || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tally-labels.pdf';
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useQrImageUrl(code: string) {
  return `/api/labels/_x_/qr/${code}`;
}
