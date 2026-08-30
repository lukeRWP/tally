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

interface ReportBody {
  reportType: ReportTypeId;
  propertyId: number;
  format: 'pdf' | 'csv';
  groupBy?: ReportGroupBy;
  tagIds?: number[];
  startDate?: string;
  endDate?: string;
}

interface ReportParams extends ReportBody {
  /**
   * Names the file, and is NOT sent to the server (which knows the property
   * from `propertyId` and would strip an unknown field anyway).
   */
  propertyName?: string;
}

/** A property name as a filename fragment: "Lock-up on Mill Road" → "lock-up-on-mill-road". */
function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Today in the reader's own timezone — a report run at 22:00 is named for that evening, not tomorrow. */
function isoToday(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What the downloaded file is called.
 *
 * It used to be `tally-${reportType}-report.${ext}` for everyone, forever — so
 * two properties produced byte-different PDFs with identical names, and a year
 * of insurance reports collided into `tally-insurance-report(3).pdf` in one
 * downloads folder (#283). The server's own Content-Disposition is no better,
 * and the anchor's `download` attribute overrides it regardless.
 */
export function reportFilename(
  reportType: ReportTypeId,
  format: 'pdf' | 'csv',
  propertyName?: string,
  now?: Date,
) {
  const place = propertyName ? slugify(propertyName) : '';
  return [
    'tally',
    reportType,
    place || null,
    isoToday(now),
  ].filter(Boolean).join('-') + `.${format === 'pdf' ? 'pdf' : 'csv'}`;
}

export function useGenerateReport() {
  return useMutation({
    mutationFn: async ({ propertyName, ...body }: ReportParams) => {
      // Raw fetch (needs the binary blob response) — attach CSRF manually.
      const csrf = getCsrfToken();
      const res = await fetch('/api/reports/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to generate report');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = reportFilename(body.reportType, body.format, propertyName);
      // Appended, clicked, removed. A detached anchor's click is a
      // Chrome-ism; and revoking the object URL synchronously after click()
      // races the download the click just started, which is why the revoke
      // waits for the current task to finish instead.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
}

// ── Preview ────────────────────────────────────────────────────────────────

/** The preview envelope: the same rows `generate` would render, as JSON. */
interface ReportPreview {
  reportType: ReportTypeId;
  propertyId: number;
  data: unknown;
}

/**
 * The report's size and total before you commit to a PDF.
 *
 * This hook and its route (`GET /api/reports/_x_/preview/:type/:propertyId`)
 * were both built and neither was ever called — `grep -rn useReportPreview`
 * returned the definition only (#283). The desk's one advantage over the phone
 * is seeing a thing before you commit to it.
 */
export function useReportPreview(
  reportType: ReportTypeId | '',
  propertyId: number,
  opts: { tagIds?: number[]; enabled?: boolean } = {},
) {
  // The tag report's answer depends on which tags are ticked, so the preview
  // has to ask the same question Generate will. Every other report ignores it.
  const tagIds = opts.tagIds?.length ? [...opts.tagIds].sort((a, b) => a - b).join(',') : null;
  return useQuery({
    queryKey: ['reports', 'preview', reportType, propertyId, tagIds],
    queryFn: () =>
      api.get<ReportPreview>(
        `/api/reports/_x_/preview/${reportType}/${propertyId}${tagIds ? `?tagIds=${tagIds}` : ''}`,
      ),
    enabled: (opts.enabled ?? true) && !!reportType && !!propertyId,
    // A glance before committing, not a live figure: re-asking on every
    // panel toggle would refetch the whole report body to redraw one line.
    staleTime: 30_000,
  });
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

function countTreeItems(containers: unknown): number {
  if (!Array.isArray(containers)) return 0;
  return containers.reduce((sum: number, c) => {
    const node = c as { items?: unknown[]; children?: unknown };
    return sum + (Array.isArray(node.items) ? node.items.length : 0) + countTreeItems(node.children);
  }, 0);
}

/**
 * One line that answers "is this the report I meant?" — e.g. "482 items ·
 * $34,900". Every branch reads a shape `reports.service.js` actually returns;
 * anything unrecognised answers null rather than guessing, because a wrong
 * count beside Generate is worse than no count at all.
 */
export function summariseReport(reportType: ReportTypeId, data: unknown): string | null {
  if (!Array.isArray(data)) return null;

  switch (reportType) {
    case 'insurance': {
      const rows = data as { currentValue?: number | null }[];
      const total = rows.reduce((s, r) => s + (r.currentValue ?? 0), 0);
      return `${plural(rows.length, 'item')} · ${money(total)}`;
    }
    case 'total_value': {
      const groups = data as { itemCount?: number; currentTotal?: number; excludedCount?: number }[];
      const items = groups.reduce((s, g) => s + (g.itemCount ?? 0), 0);
      const total = groups.reduce((s, g) => s + (g.currentTotal ?? 0), 0);
      const excluded = groups.reduce((s, g) => s + (g.excludedCount ?? 0), 0);
      // A box or a bag of spares carries the price of an object that is in use
      // somewhere else, so the report leaves it out — silently, unless said.
      return `${plural(items, 'item')} · ${money(total)}${excluded ? ` · ${excluded} part-only excluded` : ''}`;
    }
    case 'items_by_location': {
      const areas = data as { containers?: unknown }[];
      const items = areas.reduce((s, a) => s + countTreeItems(a.containers), 0);
      return `${plural(areas.length, 'area')} · ${plural(items, 'item')}`;
    }
    case 'lending': {
      const loans = data as { overdue?: boolean }[];
      const overdue = loans.filter((l) => l.overdue).length;
      return `${plural(loans.length, 'item')} out${overdue ? ` · ${overdue} overdue` : ''}`;
    }
    case 'activity_log':
      return plural(data.length, 'change');
    case 'tag': {
      const groups = data as { items?: unknown[] }[];
      const items = groups.reduce((s, g) => s + (Array.isArray(g.items) ? g.items.length : 0), 0);
      return `${plural(groups.length, 'tag')} · ${plural(items, 'item')}`;
    }
    default:
      return null;
  }
}
