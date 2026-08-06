import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, ChevronDown, Filter, Pencil, ArrowRight, Trash2, RotateCcw, Home as HomeIcon, Package, CircleDot } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PropertyCard } from '@/components/inventory/property-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { TagBadge } from '@/components/tags/tag-badge';
import { useProperties, useCreateProperty, useSearchItems, useAreas, type SearchFilters } from '@/hooks/use-inventory';
import { useActiveLoans } from '@/hooks/use-lending';
import { AreaCard } from '@/components/inventory/area-card';
import { usePropertyTags, type Tag } from '@/hooks/use-tags';
import { useRecentActivity, type AuditEntry } from '@/hooks/use-notifications';
import { useAuthStore } from '@/store/auth-store';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { daysOverdue } from '@/lib/dates';

// -- AllPropertyTags: fetch tags across all user properties --------------------

function useAllPropertyTags(properties: Array<{ id: number }> | undefined): Tag[] {
  // Call hooks for up to 10 properties (hooks must not be called conditionally).
  // We gate on `enabled` to avoid firing requests for unused slots.
  const p0 = usePropertyTags(properties?.[0]?.id ?? 0);
  const p1 = usePropertyTags(properties?.[1]?.id ?? 0);
  const p2 = usePropertyTags(properties?.[2]?.id ?? 0);
  const p3 = usePropertyTags(properties?.[3]?.id ?? 0);
  const p4 = usePropertyTags(properties?.[4]?.id ?? 0);
  const p5 = usePropertyTags(properties?.[5]?.id ?? 0);
  const p6 = usePropertyTags(properties?.[6]?.id ?? 0);
  const p7 = usePropertyTags(properties?.[7]?.id ?? 0);
  const p8 = usePropertyTags(properties?.[8]?.id ?? 0);
  const p9 = usePropertyTags(properties?.[9]?.id ?? 0);

  const count = properties?.length ?? 0;
  const all = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9]
    .slice(0, count)
    .flatMap((q) => (q.data as Tag[] | undefined) ?? []);

  // Deduplicate by tag ID
  const seen = new Set<number>();
  return all.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// -- Pill button -------------------------------------------------------------

function PillButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 border',
        active
          ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
          : 'bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
      )}
    >
      {label}
    </button>
  );
}

// -- Condition options -------------------------------------------------------

const CONDITIONS: Array<{ label: string; value: string | null }> = [
  { label: 'All', value: null },
  { label: 'New', value: 'new' },
  { label: 'Good', value: 'good' },
  { label: 'Fair', value: 'fair' },
  { label: 'Poor', value: 'poor' },
];

// Which activity entries can be tapped through to their entity.
const ACTIVITY_ROUTES: Record<string, string> = {
  item: '/item',
  container: '/container',
  area: '/area',
  property: '/property',
};

const STATUSES: Array<{ label: string; value: string }> = [
  // 'All' first and default: the thing you most need to FIND is often exactly
  // the thing that is lent out — hiding those by default made search return
  // zero results for the very item you were hunting.
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Removed', value: 'removed' },
  { label: 'Lent', value: 'lent' },
];

// -- Greeting helper ---------------------------------------------------------

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// -- Activity feed helpers ---------------------------------------------------

function activityDotColor(action: string): string {
  switch (action) {
    case 'created':
      return 'bg-[var(--color-green)]';
    case 'updated':
      return 'bg-[var(--color-primary)]';
    case 'moved':
      return 'bg-[var(--color-amber)]';
    case 'deleted':
      return 'bg-[var(--color-red)]';
    case 'restored':
      return 'bg-[var(--color-purple)]';
    default:
      return 'bg-[var(--color-text-muted)]';
  }
}

function activityIcon(action: string) {
  switch (action) {
    case 'created':
      return <Plus className="w-3.5 h-3.5" />;
    case 'updated':
      return <Pencil className="w-3.5 h-3.5" />;
    case 'moved':
      return <ArrowRight className="w-3.5 h-3.5" />;
    case 'deleted':
      return <Trash2 className="w-3.5 h-3.5" />;
    case 'restored':
      return <RotateCcw className="w-3.5 h-3.5" />;
    default:
      return <Pencil className="w-3.5 h-3.5" />;
  }
}

function activityRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function activityDayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entry = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - entry.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function activityLabel(entry: AuditEntry): React.ReactNode {
  const name = typeof entry.changes?.name === 'string' ? entry.changes.name : entry.entityType;
  return (
    <span>
      {entry.displayName} {entry.action} {entry.entityType} <span className="font-semibold text-[var(--color-text)]">{name}</span>
    </span>
  );
}

// -- Home page ---------------------------------------------------------------

export function Home() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);

  // Filter state
  const [selectedTagIds, setSelectedTagIds] = React.useState<number[]>([]);
  const [selectedCondition, setSelectedCondition] = React.useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = React.useState<string>('all');

  // Filter panel visibility (collapsible on mobile)
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // Activity feed collapsed/expanded
  const [activityExpanded, setActivityExpanded] = React.useState(false);

  // Tag dropdown
  const [tagDropdownOpen, setTagDropdownOpen] = React.useState(false);
  const tagDropdownRef = React.useRef<HTMLDivElement>(null);

  const { data: properties, isLoading: propertiesLoading } = useProperties();
  const { data: activeLoans } = useActiveLoans();
  // Single-property households skip the ceremony of a one-card property list:
  // Home shows the areas themselves. The property page stays reachable via the
  // header link for edits and members.
  const singleProperty = properties && properties.length === 1 ? properties[0] : null;
  const { data: singlePropertyAreas } = useAreas(singleProperty?.id ?? 0);

  const createProperty = useCreateProperty();
  const allTags = useAllPropertyTags(properties);
  const { data: recentActivity, isLoading: activityLoading } = useRecentActivity();

  // Build filters for search
  const filters: SearchFilters = {
    tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    condition: selectedCondition ?? undefined,
    status: selectedStatus === 'all' ? undefined : selectedStatus,
  };

  const { data: searchResults } = useSearchItems(searchQuery, filters);

  // Debounce search
  React.useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Close tag dropdown on outside click
  React.useEffect(() => {
    if (!tagDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [tagDropdownOpen]);

  function handleCreateProperty(data: Record<string, unknown>) {
    return createProperty.mutateAsync(data as { name: string; address?: string; description?: string })
      .then(() => toast('Property created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  function toggleTag(tagId: number) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  function removeSelectedTag(tagId: number) {
    setSelectedTagIds((prev) => prev.filter((id) => id !== tagId));
  }

  const selectedTags = allTags.filter((t) => selectedTagIds.includes(t.id));
  const hasActiveFilters =
    selectedTagIds.length > 0 || selectedCondition !== null || selectedStatus !== 'all';

  // Compute stats from properties
  const totalItems = properties?.reduce((sum, p) => sum + p.itemCount, 0) ?? 0;
  const totalContainers = properties?.reduce((sum, p) => sum + p.containerCount, 0) ?? 0;
  const totalAreas = properties?.reduce((sum, p) => sum + p.areaCount, 0) ?? 0;

  // Find the most-populated property
  const maxItemPropertyId = properties && properties.length > 0
    ? properties.reduce((max, p) => (p.itemCount > max.itemCount ? p : max), properties[0]).id
    : -1;

  // Group activity by day
  const activityEntries = recentActivity?.slice(0, 10) ?? [];
  const activityByDay: Array<{ label: string; entries: typeof activityEntries }> = [];
  let lastDayLabel = '';
  for (const entry of activityEntries) {
    const dayLabel = activityDayLabel(entry.createdAt);
    if (dayLabel !== lastDayLabel) {
      activityByDay.push({ label: dayLabel, entries: [] });
      lastDayLabel = dayLabel;
    }
    activityByDay[activityByDay.length - 1].entries.push(entry);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Hero Greeting */}
      <div className="animate-fade-up">
        <h1 className="text-2xl font-extrabold text-[var(--color-text)] tracking-tight">
          {getGreeting()}, {user?.displayName?.split(' ')[0] ?? 'there'}
        </h1>

        {/* Stat chips */}
        {properties && properties.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-primary-bg)] text-[var(--color-primary)] text-xs font-semibold whitespace-nowrap shrink-0">
              <Package className="w-3.5 h-3.5" />
              {totalItems} items
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-amber-bg)] text-[var(--color-amber)] text-xs font-semibold whitespace-nowrap shrink-0">
              <CircleDot className="w-3.5 h-3.5" />
              {totalContainers} containers
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple)] text-xs font-semibold whitespace-nowrap shrink-0">
              <HomeIcon className="w-3.5 h-3.5" />
              {totalAreas} areas
            </div>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative animate-fade-up" style={{ animationDelay: '30ms' }}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-[var(--color-text-muted)]" />
        <Input
          placeholder="Search items..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-10 pr-12 h-12 text-base bg-[var(--color-elevated)] focus:shadow-[inset_0_0_0_2px_var(--color-primary)] transition-shadow duration-200"
        />
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            'absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-xs transition-colors duration-200',
            filtersOpen || hasActiveFilters
              ? 'text-[var(--color-primary)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          )}
          aria-label="Toggle filters"
        >
          <Filter className="w-4 h-4" />
          {hasActiveFilters && (
            <span className="text-[10px] font-semibold leading-none">
              {(selectedTagIds.length > 0 ? 1 : 0) +
                (selectedCondition !== null ? 1 : 0) +
                (selectedStatus !== 'all' ? 1 : 0)}
            </span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div className="flex flex-col gap-3 p-3 rounded-[var(--radius-lg)] bg-[var(--color-elevated)] border border-[var(--color-border)] animate-scale-in">
          {/* Tag filter */}
          {allTags.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
                Tags
              </p>
              <div className="relative" ref={tagDropdownRef}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTagDropdownOpen((v) => !v)}
                  className="h-7 px-2.5 text-xs gap-1"
                >
                  Tags
                  {selectedTagIds.length > 0 && (
                    <span className="ml-0.5 text-[var(--color-primary)] font-semibold">
                      ({selectedTagIds.length})
                    </span>
                  )}
                  <ChevronDown
                    className={cn('w-3 h-3 transition-transform duration-200', tagDropdownOpen && 'rotate-180')}
                  />
                </Button>

                {tagDropdownOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-1.5 flex flex-col gap-0.5 animate-scale-in">
                    {allTags.map((tag) => {
                      const isSelected = selectedTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-left transition-all duration-150 w-full',
                            isSelected
                              ? 'bg-[var(--color-primary-bg)]'
                              : 'hover:bg-[var(--color-elevated)]',
                          )}
                        >
                          <div
                            className="w-3 h-3 rounded-sm shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="text-sm text-[var(--color-text)]">{tag.name}</span>
                          {isSelected && (
                            <span className="ml-auto text-[var(--color-primary)] text-xs font-bold">
                              ✓
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Selected tag chips */}
              {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selectedTags.map((tag) => (
                    <TagBadge key={tag.id} tag={tag} size="sm" onRemove={() => removeSelectedTag(tag.id)} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Condition filter */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
              Condition
            </p>
            <div className="flex flex-wrap gap-1.5">
              {CONDITIONS.map(({ label, value }) => (
                <PillButton
                  key={label}
                  label={label}
                  active={selectedCondition === value}
                  onClick={() => setSelectedCondition(value)}
                />
              ))}
            </div>
          </div>

          {/* Status filter */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5 font-medium">
              Status
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map(({ label, value }) => (
                <PillButton
                  key={value}
                  label={label}
                  active={selectedStatus === value}
                  onClick={() => setSelectedStatus(value)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Search Results */}
      {searchQuery.length >= 1 && searchResults && searchResults.length > 0 && (
        <section className="animate-fade-up">
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">
            Items ({searchResults.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {searchResults.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {searchQuery.length >= 1 && searchResults && searchResults.length === 0 && (
        <div className="flex flex-col items-center py-8 gap-2 animate-fade-up">
          <Search className="w-8 h-8 text-[var(--color-text-muted)]" />
          <p className="text-sm text-[var(--color-text-muted)] text-center">
            No items found for &ldquo;{searchQuery}&rdquo;
          </p>
        </div>
      )}

      {/* On loan — the things currently out of the house. Only renders when
          something actually is; Return lives on the Alerts page. */}
      {activeLoans && activeLoans.length > 0 && (
        <section className="animate-fade-up" style={{ animationDelay: '50ms' }}>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              On loan ({activeLoans.length})
            </h2>
            <button
              type="button"
              onClick={() => navigate('/notifications')}
              className="text-xs text-[var(--color-primary)] hover:underline"
            >
              View all
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {activeLoans.slice(0, 3).map((loan) => {
              const overdueDays = loan.dueAt
                ? daysOverdue(loan.dueAt)
                : null;
              return (
                <button
                  key={loan.id}
                  type="button"
                  onClick={() => navigate(`/item/${loan.itemId}`)}
                  className="flex items-center gap-3 p-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-card)] text-left hover:bg-[var(--color-elevated)] transition-colors"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-[var(--color-text)] truncate">
                      {loan.itemName ?? `Item #${loan.itemId}`}
                    </span>
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      {loan.lentTo}
                      {overdueDays !== null && overdueDays > 0 && (
                        <span className="text-[var(--color-red)] font-medium"> · {overdueDays}d overdue</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent Activity */}
      <section className="animate-fade-up" style={{ animationDelay: '100ms' }}>
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setActivityExpanded(!activityExpanded)}
            className="flex items-center gap-2"
          >
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Recent Activity</h2>
            <ChevronDown className={cn(
              "w-4 h-4 text-[var(--color-text-muted)] transition-transform duration-200",
              activityExpanded && "rotate-180"
            )} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/notifications')}
            className="text-xs text-[var(--color-primary)] hover:underline transition-colors duration-150"
          >
            View all
          </button>
        </div>

        {activityLoading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {!activityLoading && (!recentActivity || recentActivity.length === 0) && (
          <div className="flex flex-col items-center py-6 gap-2">
            <Package className="w-8 h-8 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)] text-center">
              No recent activity
            </p>
          </div>
        )}

        {!activityLoading && recentActivity && recentActivity.length > 0 && (() => {
          // Flatten entries for slicing when collapsed
          const visibleEntries = activityExpanded ? activityEntries : activityEntries.slice(0, 3);
          const visibleByDay: Array<{ label: string; entries: typeof activityEntries }> = [];
          let lastDay = '';
          for (const entry of visibleEntries) {
            const dayLabel = activityDayLabel(entry.createdAt);
            if (dayLabel !== lastDay) {
              visibleByDay.push({ label: dayLabel, entries: [] });
              lastDay = dayLabel;
            }
            visibleByDay[visibleByDay.length - 1].entries.push(entry);
          }

          return (
            <div className="flex flex-col gap-0">
              {visibleByDay.map((group, gIdx) => (
                <div key={group.label}>
                  {/* Day divider */}
                  <div className={cn(
                    'flex items-center gap-2 py-1.5',
                    gIdx > 0 && 'mt-2',
                  )}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      {group.label}
                    </span>
                    <div className="flex-1 h-px bg-[var(--color-border)]" />
                  </div>

                  {group.entries.map((entry, idx) => (
                    // Rows navigate to their entity — they were inert spans,
                    // which made the feed a dead end ("moved WHERE?" answered
                    // only by hunting). Unknown entity types stay inert.
                    <div
                      key={entry.id}
                      role={ACTIVITY_ROUTES[entry.entityType] ? 'button' : undefined}
                      tabIndex={ACTIVITY_ROUTES[entry.entityType] ? 0 : undefined}
                      onClick={() => {
                        const base = ACTIVITY_ROUTES[entry.entityType];
                        if (base) navigate(`${base}/${entry.entityId}`);
                      }}
                      onKeyDown={(e) => {
                        const base = ACTIVITY_ROUTES[entry.entityType];
                        if (base && (e.key === 'Enter' || e.key === ' ')) {
                          // Space scrolls the page by default — a role=button must eat it.
                          e.preventDefault();
                          navigate(`${base}/${entry.entityId}`);
                        }
                      }}
                      className={cn(
                        'flex items-start gap-3 text-xs py-1.5 animate-fade-up',
                        ACTIVITY_ROUTES[entry.entityType] &&
                          'cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--color-elevated)] -mx-1 px-1',
                      )}
                      style={{ animationDelay: `${idx * 30}ms` }}
                    >
                      {/* Colored dot */}
                      <span className={cn(
                        'flex-shrink-0 mt-1.5 w-2 h-2 rounded-full',
                        activityDotColor(entry.action),
                      )} />
                      <span className="flex-1 text-[var(--color-text-secondary)] line-clamp-1">
                        {activityLabel(entry)}
                      </span>
                      <span className="flex-shrink-0 text-[var(--color-text-muted)]">
                        {activityRelativeTime(entry.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}

              {!activityExpanded && activityEntries.length > 3 && (
                <button
                  type="button"
                  onClick={() => setActivityExpanded(true)}
                  className="text-xs text-[var(--color-primary)] mt-2 text-left hover:underline"
                >
                  Show {activityEntries.length - 3} more
                </button>
              )}

              {activityExpanded && activityEntries.length > 3 && (
                <button
                  type="button"
                  onClick={() => setActivityExpanded(false)}
                  className="text-xs text-[var(--color-primary)] mt-2 text-left hover:underline"
                >
                  Show less
                </button>
              )}
            </div>
          );
        })()}
      </section>

      {/* Properties */}
      <section className="animate-fade-up" style={{ animationDelay: '150ms' }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">
            {singleProperty ? singleProperty.name : 'Your Properties'}
          </h2>
          <div className="flex items-center gap-3">
            {singleProperty ? (
              <button
                type="button"
                onClick={() => navigate(`/property/${singleProperty.id}`)}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                View property
              </button>
            ) : (
              properties && properties.length > 0 && (
                <span className="text-xs font-medium text-[var(--color-text-muted)] bg-[var(--color-elevated)] px-2 py-0.5 rounded-full">
                  {properties.length} properties
                </span>
              )
            )}
            {/* Property creation demoted from a hero Quick Action to a quiet
                link — it happens roughly once per house. */}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              + Add
            </button>
          </div>
        </div>

        {propertiesLoading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {properties && properties.length === 0 && (
          <div className="flex flex-col items-center py-10 gap-3 animate-fade-up">
            <div className="w-14 h-14 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center">
              <HomeIcon className="w-7 h-7 text-[var(--color-primary)]" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-[var(--color-text)]">No properties yet</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Create a property to start organizing your inventory</p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4" />
              Create Property
            </Button>
          </div>
        )}

        {singleProperty ? (
          // The one-property household is the actual household: a list with a
          // single card that must be tapped through conveys nothing. Land on
          // the areas directly.
          singlePropertyAreas && singlePropertyAreas.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {singlePropertyAreas.map((area) => (
                <AreaCard key={area.id} area={area} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)] py-4 text-center">
              No areas yet — add one from the property page.
            </p>
          )
        ) : properties && properties.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {properties.map((property, idx) => (
              <div
                key={property.id}
                className={cn(
                  property.id === maxItemPropertyId && 'border-l-[3px] border-l-[var(--color-primary)] rounded-l-sm',
                )}
              >
                <PropertyCard property={property} index={idx} />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="property"
        onSubmit={handleCreateProperty}
        isPending={createProperty.isPending}
      />
    </div>
  );
}
