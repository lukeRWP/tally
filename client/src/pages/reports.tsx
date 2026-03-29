import * as React from 'react';
import {
  FileText,
  DollarSign,
  Layers,
  HandCoins,
  History,
  Tag,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useProperties } from '@/hooks/use-inventory';
import { usePropertyTags } from '@/hooks/use-tags';
import { useGenerateReport } from '@/hooks/use-reports';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

interface ReportType {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  borderColor: string;
  hasGroupBy?: boolean;
  hasTagSelect?: boolean;
}

const REPORT_TYPES: ReportType[] = [
  {
    id: 'insurance',
    label: 'Insurance Summary',
    description: 'Items with values, condition, photos',
    icon: FileText,
    iconColor: 'text-[var(--color-primary)]',
    iconBg: 'bg-[var(--color-primary-bg)]',
    borderColor: 'border-l-[var(--color-primary)]',
  },
  {
    id: 'total-value',
    label: 'Total Value',
    description: 'Aggregate by location or tag',
    icon: DollarSign,
    iconColor: 'text-[var(--color-green)]',
    iconBg: 'bg-[var(--color-green-bg)]',
    borderColor: 'border-l-[var(--color-green)]',
    hasGroupBy: true,
  },
  {
    id: 'by-location',
    label: 'Items by Location',
    description: 'Hierarchical inventory view',
    icon: Layers,
    iconColor: 'text-[var(--color-purple)]',
    iconBg: 'bg-[var(--color-purple-bg)]',
    borderColor: 'border-l-[var(--color-purple)]',
  },
  {
    id: 'lending',
    label: 'Lending Report',
    description: 'Currently lent items',
    icon: HandCoins,
    iconColor: 'text-[var(--color-amber)]',
    iconBg: 'bg-[var(--color-amber-bg)]',
    borderColor: 'border-l-[var(--color-amber)]',
  },
  {
    id: 'activity',
    label: 'Activity Log',
    description: 'Who did what, when',
    icon: History,
    iconColor: 'text-[var(--color-text-secondary)]',
    iconBg: 'bg-[var(--color-elevated)]',
    borderColor: 'border-l-[var(--color-text-muted)]',
  },
  {
    id: 'tags',
    label: 'Tag Report',
    description: 'Items by selected tags',
    icon: Tag,
    iconColor: 'text-[var(--color-red)]',
    iconBg: 'bg-[var(--color-red-bg)]',
    borderColor: 'border-l-[var(--color-red)]',
  },
];

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
    return <p className="text-xs text-[var(--color-text-muted)]">No tags available for this property.</p>;
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
      {tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          onClick={() => toggle(tag.id)}
          className={cn(
            'px-2.5 py-1 rounded-md text-xs font-semibold transition-all duration-200 border',
            selected.includes(tag.id)
              ? 'border-transparent text-white'
              : 'border-[var(--color-border)] text-[var(--color-text-secondary)] bg-[var(--color-elevated)]',
          )}
          style={selected.includes(tag.id) ? { backgroundColor: tag.color, borderColor: tag.color } : {}}
        >
          {tag.name}
        </button>
      ))}
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
  onGenerate: (format: 'pdf' | 'csv', groupBy?: string, tagIds?: number[]) => void;
  isPending: boolean;
}) {
  const [format, setFormat] = React.useState<'pdf' | 'csv'>('pdf');
  const [groupBy, setGroupBy] = React.useState('location');
  const [tagIds, setTagIds] = React.useState<number[]>([]);

  return (
    <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex flex-col gap-3 animate-fade-up">
      {/* Format toggle -- segmented control */}
      <div>
        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Format</p>
        <div className="flex gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
          {(['pdf', 'csv'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={cn(
                'flex-1 px-3 py-1.5 rounded-[var(--radius-sm)] text-sm font-medium transition-all duration-200 cursor-pointer uppercase',
                format === f
                  ? 'bg-[var(--color-card)] text-[var(--color-primary)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Group-by for Total Value -- segmented */}
      {report.hasGroupBy && (
        <div>
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Group By</p>
          <div className="flex gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
            {(['location', 'tag', 'condition'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setGroupBy(opt)}
                className={cn(
                  'flex-1 px-3 py-1.5 rounded-[var(--radius-sm)] text-sm font-medium transition-all duration-200 cursor-pointer capitalize',
                  groupBy === opt
                    ? 'bg-[var(--color-card)] text-[var(--color-primary)] shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tag multiselect for Tag Report */}
      {report.hasTagSelect && (
        <div>
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Tags</p>
          <TagMultiSelect propertyId={propertyId} selected={tagIds} onChange={setTagIds} />
        </div>
      )}

      {/* Generate button */}
      <Button
        onClick={() => onGenerate(format, report.hasGroupBy ? groupBy : undefined, report.hasTagSelect ? tagIds : undefined)}
        disabled={isPending}
        className="w-full"
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
  const { data: propertiesData } = useProperties();
  const properties = (propertiesData as unknown as { properties: { id: number; name: string }[] })?.properties
    ?? (propertiesData as unknown as { id: number; name: string }[])
    ?? [];

  const [propertyId, setPropertyId] = React.useState<number>(0);
  const [expandedReport, setExpandedReport] = React.useState<string | null>(null);

  const generateReport = useGenerateReport();

  // Auto-select the first property once data loads
  React.useEffect(() => {
    if (!propertyId && properties.length > 0) {
      setPropertyId(properties[0].id);
    }
  }, [properties, propertyId]);

  function handleCardClick(reportId: string) {
    setExpandedReport((prev) => (prev === reportId ? null : reportId));
  }

  function handleGenerate(
    report: ReportType,
    format: 'pdf' | 'csv',
    groupBy?: string,
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

  // Insurance report is the featured one
  const insuranceReport = REPORT_TYPES.find((r) => r.id === 'insurance')!;
  const otherReports = REPORT_TYPES.filter((r) => r.id !== 'insurance');
  const isInsuranceExpanded = expandedReport === 'insurance';

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[var(--color-text)] tracking-tight animate-fade-up">Reports</h1>

      {/* Property selector -- pill style */}
      <div className="animate-fade-up" style={{ animationDelay: '50ms' }}>
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {properties.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPropertyId(p.id)}
              className={cn(
                'px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0 border',
                propertyId === p.id
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : 'bg-[var(--color-card)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
              )}
            >
              {p.name}
            </button>
          ))}
          {properties.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] py-1">No properties available.</p>
          )}
        </div>
      </div>

      {/* Featured report -- Insurance Summary, full width */}
      <div className="animate-fade-up" style={{ animationDelay: '100ms' }}>
        <Card
          className={cn(
            'cursor-pointer select-none border-l-[3px]',
            insuranceReport.borderColor,
            isInsuranceExpanded
              ? 'border-[var(--color-primary)] shadow-[0_2px_12px_rgba(0,0,0,0.08)]'
              : 'hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] hover:border-[var(--color-primary)]/30',
          )}
          onClick={() => handleCardClick('insurance')}
        >
          <div className="flex items-start gap-3">
            <div className={cn('flex items-center justify-center w-12 h-12 rounded-[var(--radius-lg)] shrink-0', insuranceReport.iconBg)}>
              <FileText className={cn('w-6 h-6', insuranceReport.iconColor)} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-[var(--color-text)] leading-tight">{insuranceReport.label}</p>
              <p className="text-sm text-[var(--color-text-muted)] mt-0.5 leading-snug">{insuranceReport.description}</p>
              {!isInsuranceExpanded && propertyId > 0 && (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCardClick('insurance');
                  }}
                >
                  Generate
                </Button>
              )}
            </div>
          </div>

          {isInsuranceExpanded && propertyId > 0 && (
            <ReportOptionsPanel
              report={insuranceReport}
              propertyId={propertyId}
              onGenerate={(format, groupBy, tagIds) => handleGenerate(insuranceReport, format, groupBy, tagIds)}
              isPending={generateReport.isPending}
            />
          )}

          {isInsuranceExpanded && !propertyId && (
            <p className="mt-3 pt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
              Select a property above to configure this report.
            </p>
          )}
        </Card>
      </div>

      {/* Other reports -- 2-column grid with colored left borders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {otherReports.map((report, idx) => {
          const Icon = report.icon;
          const isExpanded = expandedReport === report.id;

          return (
            <div
              key={report.id}
              className={cn(
                'col-span-1 animate-fade-up',
                isExpanded && 'col-span-2 lg:col-span-3',
              )}
              style={{ animationDelay: `${(idx + 3) * 50}ms` }}
            >
              <Card
                className={cn(
                  'cursor-pointer select-none border-l-[3px]',
                  report.borderColor,
                  isExpanded
                    ? 'border-[var(--color-primary)] shadow-[0_2px_12px_rgba(0,0,0,0.08)]'
                    : 'hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] hover:border-[var(--color-primary)]/30',
                )}
                onClick={() => handleCardClick(report.id)}
              >
                <div className="flex items-start gap-3">
                  <div className={cn('flex items-center justify-center w-10 h-10 rounded-[var(--radius-lg)] shrink-0', report.iconBg)}>
                    <Icon className={cn('w-5 h-5', report.iconColor)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[var(--color-text)] leading-tight">{report.label}</p>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5 leading-snug">{report.description}</p>
                  </div>
                </div>

                {isExpanded && propertyId > 0 && (
                  <ReportOptionsPanel
                    report={report}
                    propertyId={propertyId}
                    onGenerate={(format, groupBy, tagIds) => handleGenerate(report, format, groupBy, tagIds)}
                    isPending={generateReport.isPending}
                  />
                )}

                {isExpanded && !propertyId && (
                  <p className="mt-3 pt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
                    Select a property above to configure this report.
                  </p>
                )}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}
