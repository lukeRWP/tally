import * as React from 'react';
import {
  FileText,
  DollarSign,
  Layers,
  HandCoins,
  History,
  Tag,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { PropertyChips } from '@/components/inventory/property-chips';
import { useProperties } from '@/hooks/use-inventory';
import { usePropertyTags } from '@/hooks/use-tags';
import {
  REPORT_GROUP_BY,
  useGenerateReport,
  type ReportGroupBy,
  type ReportTypeId,
} from '@/hooks/use-reports';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

interface ReportType {
  // The server's spelling, not a display id — it is posted verbatim (#263).
  id: ReportTypeId;
  label: string;
  description: string;
  icon: React.ElementType;
  hasGroupBy?: boolean;
  hasTagSelect?: boolean;
}

// Six hues across six rows is a card-grid tactic. A ruled list separates rows
// with ink and spends orange only on the one currently open.
const REPORT_TYPES: ReportType[] = [
  {
    id: 'insurance',
    label: 'Insurance Summary',
    description: 'Items with values, condition, photos',
    icon: FileText,
  },
  {
    id: 'total_value',
    label: 'Total Value',
    description: 'Aggregate by property, area, or tag',
    icon: DollarSign,
    hasGroupBy: true,
  },
  {
    id: 'items_by_location',
    label: 'Items by Location',
    description: 'Hierarchical inventory view',
    icon: Layers,
  },
  {
    id: 'lending',
    label: 'Lending Report',
    description: 'Currently lent items',
    icon: HandCoins,
  },
  {
    id: 'activity_log',
    label: 'Activity Log',
    description: 'Who did what, when',
    icon: History,
  },
  {
    id: 'tag',
    label: 'Tag Report',
    description: 'Items by selected tags',
    icon: Tag,
    hasTagSelect: true,
  },
];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}

function TagMultiSelect({
  propertyId,
  selected,
  onChange,
}: {
  propertyId: number;
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: tags } = usePropertyTags(propertyId);

  if (!tags || tags.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        No tags for this property
      </p>
    );
  }

  function toggle(id: number) {
    if (selected.includes(id)) {
      onChange(selected.filter((t) => t !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const on = selected.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(tag.id)}
            className={cn(
              // Filter chips stay pills; only badges and buttons are squared.
              'inline-flex items-center gap-1.5 rounded-full border px-3 min-h-[max(32px,var(--tap-min))] font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
              on
                ? 'bg-[var(--color-text)] text-[var(--color-bg)] border-[var(--color-text)]'
                : 'border-[var(--color-rule)] text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]',
            )}
          >
            {/* The tag's own colour is identity, not state — a user hex can't be
                trusted to stay legible as a fill on either ground. */}
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} aria-hidden="true" />
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

function ReportOptionsPanel({
  report,
  propertyId,
  onGenerate,
  isPending,
}: {
  report: ReportType;
  propertyId: number;
  onGenerate: (format: 'pdf' | 'csv', groupBy?: ReportGroupBy, tagIds?: number[]) => void;
  isPending: boolean;
}) {
  const [format, setFormat] = React.useState<'pdf' | 'csv'>('pdf');
  // 'area' is the server's name for what this control used to call 'location'.
  // The third old option, 'condition', was never grouped by anything on the
  // server — see #263.
  const [groupBy, setGroupBy] = React.useState<ReportGroupBy>('area');
  const [tagIds, setTagIds] = React.useState<number[]>([]);

  return (
    // No rule along the top: the row this panel hangs off already carries one,
    // and a second would double up inside a single cell.
    <div className="flex flex-col gap-3 pb-3 animate-fade-up">
      <div className="flex flex-col gap-1.5">
        <FieldLabel>Format</FieldLabel>
        <div className="flex gap-2">
          {(['pdf', 'csv'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={format === f ? 'default' : 'outline'}
              aria-pressed={format === f}
              onClick={() => setFormat(f)}
            >
              {f}
            </Button>
          ))}
        </div>
      </div>

      {report.hasGroupBy && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Group by</FieldLabel>
          <div className="flex gap-2">
            {REPORT_GROUP_BY.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={groupBy === opt ? 'default' : 'outline'}
                aria-pressed={groupBy === opt}
                onClick={() => setGroupBy(opt)}
              >
                {opt}
              </Button>
            ))}
          </div>
        </div>
      )}

      {report.hasTagSelect && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Tags</FieldLabel>
          <TagMultiSelect propertyId={propertyId} selected={tagIds} onChange={setTagIds} />
        </div>
      )}

      <Button
        onClick={() => onGenerate(format, report.hasGroupBy ? groupBy : undefined, report.hasTagSelect ? tagIds : undefined)}
        disabled={isPending}
        className="w-full sm:w-auto sm:self-start"
      >
        {isPending ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Generating...
          </>
        ) : (
          'Generate'
        )}
      </Button>
    </div>
  );
}

export function Reports() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const { data: properties = [] } = useProperties();

  const [propertyId, setPropertyId] = React.useState<number>(0);
  const [expandedReport, setExpandedReport] = React.useState<ReportTypeId | null>(null);

  const generateReport = useGenerateReport();

  // Auto-select the first property once data loads
  React.useEffect(() => {
    if (!propertyId && properties.length > 0) {
      setPropertyId(properties[0].id);
    }
  }, [properties, propertyId]);

  function toggleReport(reportId: ReportTypeId) {
    setExpandedReport((prev) => (prev === reportId ? null : reportId));
  }

  function handleGenerate(
    report: ReportType,
    format: 'pdf' | 'csv',
    groupBy?: ReportGroupBy,
    tagIds?: number[],
  ) {
    if (!propertyId) {
      toast.error('Please select a property first');
      return;
    }
    generateReport.mutate(
      {
        reportType: report.id,
        propertyId,
        format,
        groupBy,
        tagIds,
      },
      {
        onSuccess: () => toast.success(`${report.label} downloaded`),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  // See the note over the menu below. Column 'a' keeps its key across a
  // breakpoint flip, so the rows in it (and an options panel open in one of
  // them) are preserved rather than remounted.
  const columns: [string, ReportType[]][] = wide
    ? [
        ['a', REPORT_TYPES.filter((_, i) => i % 2 === 0)],
        ['b', REPORT_TYPES.filter((_, i) => i % 2 === 1)],
      ]
    : [['a', REPORT_TYPES]];

  return (
    <div className="flex flex-col gap-5">
      <h1 className="animate-fade-up"><TitleBar>Reports</TitleBar></h1>

      <PropertyChips properties={properties} value={propertyId} onChange={setPropertyId} />
      {properties.length === 0 && (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
          No properties available
        </p>
      )}

      <section className="flex flex-col">
        <ColHead>Reports · {REPORT_TYPES.length}</ColHead>

        {/* Two columns at a desk. Six rows is a MENU, not a list, and stretching
            a menu to 1400px puts the chevron a screen away from the label it
            belongs to.

            The two columns are INDEPENDENT stacks, not cells of one row-major
            grid. In a grid every row is as tall as its tallest cell, so opening
            a panel in the right column pushed the whole next row down and left
            an equally tall hole in the left one — measured at 1440×900, four
            rows jumped 239px and the facing column went blank (#275). Spanning
            the open row across both columns does not fix that: a two-column
            item cannot start in column 2, so it drops to a row of its own,
            still leaving the hole and moving the rows below by 301px instead of
            239. Splitting the list into per-column stacks does fix it — the
            facing column never moves at all, and only the rows below the open
            one in its own column shift, which is what an accordion is for.

            Reading order is unchanged: column A takes reports 1/3/5 and column
            B takes 2/4/6, so each pair still lands side by side exactly where
            the grid put it. */}
        <div className={cn(wide && 'grid grid-cols-2 gap-x-6 items-start')}>
        {columns.map(([colKey, column]) => (
        <div key={colKey} className="flex flex-col">
        {column.map((report) => {
          const Icon = report.icon;
          const isExpanded = expandedReport === report.id;
          // Keyed off the canonical order so the entry stagger still reads
          // row by row rather than down one column and then the other.
          const idx = REPORT_TYPES.indexOf(report);

          return (
            <div
              key={report.id}
              // Which stack a row sits in is the whole of the #275 fix, and it
              // is invisible to a DOM-only test without this.
              data-report-row={report.id}
              className="border-b border-[var(--color-rule)] last:border-b-0 animate-fade-up"
              style={{ animationDelay: `${idx * 40}ms` }}
            >
              {/* Hand-built rather than RuledRow: the options panel below holds
                  buttons of its own, which cannot live inside a row that is
                  itself a <button>. */}
              <button
                type="button"
                onClick={() => toggleReport(report.id)}
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-[var(--color-elevated)]/60 active:bg-[var(--color-elevated)] focus-visible:outline-none focus-visible:bg-[var(--color-elevated)]"
              >
                <Icon
                  className={cn(
                    'w-4 h-4 shrink-0',
                    isExpanded ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{report.label}</span>
                  <span className="block truncate font-mono text-[11px] tracking-[0.02em] text-[var(--color-text-muted)]">
                    {report.description}
                  </span>
                </span>
                <ChevronRight
                  className={cn(
                    'w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform',
                    isExpanded && 'rotate-90',
                  )}
                />
              </button>

              {isExpanded && (propertyId > 0 ? (
                <ReportOptionsPanel
                  report={report}
                  propertyId={propertyId}
                  onGenerate={(format, groupBy, tagIds) => handleGenerate(report, format, groupBy, tagIds)}
                  isPending={generateReport.isPending}
                />
              ) : (
                <p className="pb-3 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                  Pick a property above to configure this report
                </p>
              ))}
            </div>
          );
        })}
        </div>
        ))}
        </div>
      </section>
    </div>
  );
}
