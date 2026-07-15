import { useMutation, useQuery } from '@tanstack/react-query';
import { api, getCsrfToken } from '@/lib/api';

interface ReportParams {
  reportType: string;
  propertyId: number;
  format: 'pdf' | 'csv';
  groupBy?: string;
  tagIds?: number[];
  startDate?: string;
  endDate?: string;
}

export function useGenerateReport() {
  return useMutation({
    mutationFn: async (params: ReportParams) => {
      // Raw fetch (needs the binary blob response) — attach CSRF manually.
      const csrf = getCsrfToken();
      const res = await fetch('/api/reports/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to generate report');
      }
      const blob = await res.blob();
      const ext = params.format === 'pdf' ? 'pdf' : 'csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tally-${params.reportType}-report.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useReportPreview(reportType: string, propertyId: number) {
  return useQuery({
    queryKey: ['reports', 'preview', reportType, propertyId],
    queryFn: () => api.get(`/api/reports/_x_/preview/${reportType}/${propertyId}`),
    enabled: !!reportType && !!propertyId,
  });
}
