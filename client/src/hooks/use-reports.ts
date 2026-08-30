import { useMutation, useQuery } from '@tanstack/react-query';
import { api, getCsrfToken } from '@/lib/api';

/**
 * The report ids, spelled exactly as the server's Joi enum spells them
 * (`server/src/modules/reports/reports.schema.js` → `REPORT_TYPES`).
 *
 * This page used to carry its own hyphenated spellings — `total-value`,
 * `by-location`, `activity`, `tags` — and posted them verbatim, so four of the
 * six reports answered 422 "Validation failed" and had never once generated a
 * file (#263). These strings are the service's own switch keys, so the client
 * adopts them rather than the reverse; typing them as a union means a future
 * typo is a compile error instead of a toast.
 */
export type ReportTypeId =
  | 'insurance'
  | 'total_value'
  | 'items_by_location'
  | 'lending'
  | 'activity_log'
  | 'tag';

/** How `total_value` aggregates. `property` is a single grand total. */
export const REPORT_GROUP_BY = ['property', 'area', 'tag'] as const;
export type ReportGroupBy = (typeof REPORT_GROUP_BY)[number];

interface ReportParams {
  reportType: ReportTypeId;
  propertyId: number;
  format: 'pdf' | 'csv';
  groupBy?: ReportGroupBy;
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
