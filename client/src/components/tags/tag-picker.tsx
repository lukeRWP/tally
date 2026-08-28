import * as React from 'react';
import { Plus, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagBadge } from './tag-badge';
import {
  useEntityTags,
  usePropertyTags,
  useAddTag,
  useRemoveTag,
  useCreateTag,
  type Tag,
} from '@/hooks/use-tags';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const PRESET_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
];

interface TagPickerProps {
  entityType: 'item' | 'container' | 'area';
  entityId: number;
  propertyId: number;
  /**
   * Batch mode: apply a tag across many entities at once instead of the
   * single `entityId` above (pass 0 there — it disables the "already
   * applied" lookup, which has no single entity to ask about anyway).
   * Clicking an available tag (or creating a new one) calls `onApply`
   * instead of mutating directly, so the caller can fan it out into its own
   * per-entity loop with error isolation and progress tracking.
   */
  batchMode?: {
    onApply: (tagId: number) => void;
    /** Disables tag selection while the caller's batch loop is in flight. */
    busy?: boolean;
  };
}

export function TagPicker({ entityType, entityId, propertyId, batchMode }: TagPickerProps) {
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [newTagName, setNewTagName] = React.useState('');
  const [newTagColor, setNewTagColor] = React.useState(PRESET_COLORS[3]); // blue default
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const { data: entityTags = [] } = useEntityTags(entityType, entityId);
  const { data: propertyTags = [] } = usePropertyTags(propertyId);
  const addTag = useAddTag();
  const removeTag = useRemoveTag();
  const createTag = useCreateTag();

  // Close dropdown on outside click
  React.useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  const entityTagIds = new Set((entityTags as Tag[]).map((t) => t.id));
  const availableTags = (propertyTags as Tag[]).filter((t) => !entityTagIds.has(t.id));

  function handleAddTag(tagId: number) {
    if (batchMode) {
      // The caller owns the mutation here — it needs to fan this out across
      // every selected entity with its own error isolation, not mutate the
      // single `entityId` this instance was given (0, unused in this mode).
      batchMode.onApply(tagId);
      setDropdownOpen(false);
      return;
    }
    addTag.mutate(
      { tagId, entityType, entityId },
      {
        onSuccess: () => setDropdownOpen(false),
        onError: (err) => toast(err.message),
      },
    );
  }

  function handleRemoveTag(tagId: number) {
    removeTag.mutate(
      { tagId, entityType, entityId },
      { onError: (err) => toast(err.message) },
    );
  }

  function handleCreateTag() {
    if (!newTagName.trim()) return;
    createTag.mutate(
      { name: newTagName.trim(), color: newTagColor, propertyId },
      {
        onSuccess: (result) => {
          const tag = (result as unknown as { tag: Tag }).tag ?? result;
          setNewTagName('');
          // Immediately apply the newly created tag to the entity (or, in
          // batch mode, hand it to the caller's per-entity loop).
          if (tag?.id) {
            if (batchMode) {
              batchMode.onApply(tag.id);
            } else {
              addTag.mutate(
                { tagId: tag.id, entityType, entityId },
                { onError: (err) => toast(err.message) },
              );
            }
          }
          setDropdownOpen(false);
        },
        onError: (err) => toast(err.message),
      },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Applied tags — meaningless in batch mode: there is no single entity
          to ask "already has this tag", only many, possibly with different
          answers each. */}
      {!batchMode && (entityTags as Tag[]).map((tag) => (
        <TagBadge
          key={tag.id}
          tag={tag}
          onRemove={() => handleRemoveTag(tag.id)}
        />
      ))}

      {/* Add tag dropdown trigger */}
      <div className="relative" ref={dropdownRef}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDropdownOpen((v) => !v)}
          className="h-6 px-2 text-xs gap-1"
        >
          <Plus className="w-3 h-3" />
          Add tag
          <ChevronDown className={cn('w-3 h-3 transition-transform duration-200', dropdownOpen && 'rotate-180')} />
        </Button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-2 flex flex-col gap-1 animate-scale-in">
            {availableTags.length > 0 ? (
              <>
                <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] px-1 mb-0.5 font-medium">
                  Apply tag
                </p>
                {availableTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => handleAddTag(tag.id)}
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius-md)] hover:bg-[var(--color-elevated)] text-left transition-all duration-150 w-full"
                  >
                    <div
                      className="w-3 h-3 rounded-sm shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="text-sm text-[var(--color-text)]">{tag.name}</span>
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--color-border)]" />
              </>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)] px-1 py-1">
                {(propertyTags as Tag[]).length === 0 ? 'No tags yet' : 'All tags applied'}
              </p>
            )}

            {/* Quick-create */}
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] px-1 mb-0.5 font-medium">
              Create new
            </p>
            <div className="flex flex-col gap-2 px-1">
              <Input
                placeholder="Tag name"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
                className="h-8 text-xs px-2 py-1"
              />
              <div className="flex gap-1.5 flex-wrap">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewTagColor(color)}
                    className={cn(
                      'w-5 h-5 rounded-[var(--radius-sm)] transition-all duration-150 hover:scale-110',
                      newTagColor === color && 'ring-2 ring-offset-1 ring-[var(--color-primary)] scale-110',
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={color}
                    title={color}
                  />
                ))}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={handleCreateTag}
                disabled={!newTagName.trim() || createTag.isPending}
                className="h-7 text-xs w-full"
              >
                <Plus className="w-3 h-3" />
                Create & Apply
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
