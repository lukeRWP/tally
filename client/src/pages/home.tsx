import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ScanLine, Plus, ChevronDown, Filter, Pencil, ArrowRight, Trash2, RotateCcw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PropertyCard } from '@/components/inventory/property-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { TagBadge } from '@/components/tags/tag-badge';
import { useProperties, useCreateProperty, useSearchItems, type SearchFilters } from '@/hooks/use-inventory';
import { usePropertyTags, type Tag } from '@/hooks/use-tags';
import { useRecentActivity, type AuditEntry } from '@/hooks/use-notifications';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

// ── AllPropertyTags: fetch tags across all user properties ─────────────────

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

// ── Pill button ────────────────────────────────────────────────────────────

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
        'px-3 py-1 rounded-full text-xs font-medium transition-colors border',
        active
          ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
          : 'bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
      )}
    >
      {label}
    </button>
  );
}

// ── Condition options ──────────────────────────────────────────────────────

const CONDITIONS: Array<{ label: string; value: string | null }> = [
  { label: 'All', value: null },
  { label: 'New', value: 'new' },
  { label: 'Good', value: 'good' },
  { label: 'Fair', value: 'fair' },
  { label: 'Poor', value: 'poor' },
];

const STATUSES: Array<{ label: string; value: string }> = [
  { label: 'Active', value: 'active' },
  { label: 'Removed', value: 'removed' },
  { label: 'Lent', value: 'lent' },
];

// ── Activity feed helpers ──────────────────────────────────────────────────

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

function activityLabel(entry: AuditEntry): string {
  const name = typeof entry.changes?.name === 'string' ? entry.changes.name : entry.entityType;
  return `${entry.displayName} ${entry.action} ${entry.entityType} ${name}`;
}

// ── Home page ──────────────────────────────────────────────────────────────

export function Home() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);

  // Filter state
  const [selectedTagIds, setSelectedTagIds] = React.useState<number[]>([]);
  const [selectedCondition, setSelectedCondition] = React.useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = React.useState<string>('active');

  // Filter panel visibility (collapsible on mobile)
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // Tag dropdown
  const [tagDropdownOpen, setTagDropdownOpen] = React.useState(false);
  const tagDropdownRef = React.useRef<HTMLDivElement>(null);

  const { data: properties, isLoading: propertiesLoading } = useProperties();
  const createProperty = useCreateProperty();
  const allTags = useAllPropertyTags(properties);
  const { data: recentActivity, isLoading: activityLoading } = useRecentActivity();

  // Build filters for search
  const filters: SearchFilters = {
    tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    condition: selectedCondition ?? undefined,
    status: selectedStatus,
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
    createProperty.mutate(data as { name: string; address?: string; description?: string }, {
      onSuccess: () => toast('Property created'),
      onError: (err) => toast(err.message),
    });
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
    selectedTagIds.length > 0 || selectedCondition !== null || selectedStatus !== 'active';

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
        <Input
          placeholder="Search items..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9 pr-12"
        />
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            'absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-xs transition-colors',
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
                (selectedStatus !== 'active' ? 1 : 0)}
            </span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div className="flex flex-col gap-3 p-3 rounded-[var(--radius-lg)] bg-[var(--color-elevated)] border border-[var(--color-border)]">
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
                    className={cn('w-3 h-3 transition-transform', tagDropdownOpen && 'rotate-180')}
                  />
                </Button>

                {tagDropdownOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-lg p-1.5 flex flex-col gap-0.5">
                    {allTags.map((tag) => {
                      const isSelected = selectedTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-left transition-colors w-full',
                            isSelected
                              ? 'bg-[var(--color-primary-bg)]'
                              : 'hover:bg-[var(--color-elevated)]',
                          )}
                        >
                          <TagBadge tag={tag} size="sm" />
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
        <section>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">
            Items ({searchResults.length})
          </h2>
          <div className="flex flex-col gap-2">
            {searchResults.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {searchQuery.length >= 1 && searchResults && searchResults.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)] text-center py-4">
          No items found for &ldquo;{searchQuery}&rdquo;
        </p>
      )}

      {/* Quick Actions */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate('/scan')} className="flex-1">
          <ScanLine className="w-4 h-4" />
          Scan
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)} className="flex-1">
          <Plus className="w-4 h-4" />
          Add Property
        </Button>
      </div>

      {/* Properties */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Your Properties</h2>

        {propertiesLoading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {properties && properties.length === 0 && (
          <p className="text-sm text-[var(--color-text-muted)] text-center py-8">
            No properties yet. Create one to get started.
          </p>
        )}

        {properties && properties.length > 0 && (
          <div className="flex flex-col gap-2">
            {properties.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}
      </section>

      {/* Recent Activity */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Recent Activity</h2>
          <button
            type="button"
            onClick={() => navigate('/notifications')}
            className="text-xs text-[var(--color-primary)] hover:underline"
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
          <p className="text-sm text-[var(--color-text-muted)] text-center py-4">
            No recent activity
          </p>
        )}

        {!activityLoading && recentActivity && recentActivity.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {recentActivity.slice(0, 10).map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 text-xs">
                <span className="flex-shrink-0 mt-0.5 text-[var(--color-text-secondary)]">
                  {activityIcon(entry.action)}
                </span>
                <span className="flex-1 text-[var(--color-text-secondary)] line-clamp-1">
                  {activityLabel(entry)}
                </span>
                <span className="flex-shrink-0 text-[var(--color-text-muted)]">
                  {activityRelativeTime(entry.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
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
