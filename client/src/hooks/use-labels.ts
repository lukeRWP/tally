import { useMutation } from '@tanstack/react-query';
import { getCsrfToken } from '@/lib/api';

export function useGenerateLabels() {
  return useMutation({
    mutationFn: async ({ entityType, entityIds, format }: { entityType: string; entityIds: number[]; format: 'pdf' | 'zpl' }) => {
      // This uses a raw fetch (not the `api` client) because it must handle a
      // binary PDF blob response. That means CSRF isn't attached automatically,
      // so add the X-CSRF-Token header here the same way api.request() does.
      const csrf = getCsrfToken();
      const res = await fetch('/api/labels/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ entityType, entityIds, format }),
      });

      if (format === 'pdf') {
        if (!res.ok) {
          const json = await res.json();
          throw new Error(json.message || 'Failed to generate labels');
        }
        const blob = await res.blob();
        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tally-labels.pdf';
        a.click();
        URL.revokeObjectURL(url);
        return { format: 'pdf' as const };
      } else {
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        return { format: 'zpl' as const, zpl: json.data.zpl as string };
      }
    },
  });
}

export function useQrImageUrl(code: string) {
  // Returns the URL for the QR code image endpoint
  return `/api/labels/_x_/qr/${code}`;
}
