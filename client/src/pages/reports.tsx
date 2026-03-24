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
  },
  {
    id: 'total-value',
    label: 'Total Value',
    description: 'Aggregate by location or tag',
    icon: DollarSign,
    iconColor: 'text-[var(--color-green)]',
    iconBg: 'bg-[var(--color-green-bg)]',
    hasGroupBy: true,
  },
  {
    id: 'by-location',
    label: 'Items by Location',
    description: 'Hierarchical inventory view',
    icon: Layers,
    iconColor: 'text-[var(--color-purple)]',
    iconBg: 'bg-[var(--color-purple-bg)]',
  },
  {
    id: 'lending',
    label: 'Lending Report',
    description: 'Currently lent items',
    icon: HandCoins,
    iconColor: 'text-[var(--color-amber)]',
    iconBg: 'bg-[var(--color-amber-bg)]',
  },
  {
    id: 'activity',
    label: 'Activity Log',
    description: 'Who did what, when',
    icon: History,
    iconColor: 'text-[var(--color-text-secondary)]',
    iconBg: 'bg-[var(--color-elevated)]',
  },
  {
    id: 'tags',
    label: 'Tag Report',
    description: 'Items by selected tags',
    icon: Tag,
    iconColor: 'text-[var(--color-red)]',
    iconBg: 'bg-[var(--color-red-bg)]',
    hasTagSelect: true,
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
            'px-2.5 py-1 rounded-full text-xs font-medium transition-all border',
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
    <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex flex-col gap-3">
      {/* Format toggle */}
      <div>
        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Format</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={format === 'pdf' ? 'default' : 'outline'}
            onClick={() => setFormat('pdf')}
            className="flex-1"
          >
            PDF
          </Button>
          <Button
            size="sm"
            variant={format === 'csv' ? 'default' : 'outline'}
            onClick={() => setFormat('csv')}
            className="flex-1"
          >
            CSV
          </Button>
        </div>
      </div>

      {/* Group-by for Total Value */}
      {report.hasGroupBy && (
        <div>
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Group By</p>
          <div className="flex gap-2">
            {(['location', 'tag', 'condition'] as const).map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={groupBy === opt ? 'default' : 'outline'}
                onClick={() => setGroupBy(opt)}
                className="flex-1 capitalize"
              >
                {opt}
              </Button>
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
            Generating…
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

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-[var(--color-text)]">Reports</h1>

      {/* Property selector */}
      <div>
        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
          Property
        </label>
        <div className="relative">
          <select
            value={propertyId}
            onChange={(e) => setPropertyId(Number(e.target.value))}
            className={cn(
              'w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)]',
              'rounded-[var(--radius-md)] px-3 py-2 pr-8 text-sm text-[var(--color-text)]',
              'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]',
            )}
          >
            <option value={0} disabled>Select a property…</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
        </div>
      </div>

      {/* Report type grid */}
      <div className="grid grid-cols-2 gap-3">
        {REPORT_TYPES.map((report) => {
          const Icon = report.icon;
          const isExpanded = expandedReport === report.id;

          return (
            <div key={report.id} className={cn('col-span-1', isExpanded && 'col-span-2')}>
              <Card
                className={cn(
                  'cursor-pointer transition-all select-none',
                  isExpanded && 'border-[var(--color-primary)]',
                )}
                onClick={() => handleCardClick(report.id)}
              >
                <div className="flex items-start gap-3">
                  <div className={cn('flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] shrink-0', report.iconBg)}>
                    <Icon className={cn('w-4 h-4', report.iconColor)} />
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
