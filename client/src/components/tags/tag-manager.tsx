import * as React from 'react';
import { Pencil, Trash2, Check, X, Plus, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagBadge } from './tag-badge';
import {
  usePropertyTags,
  useCreateTag,
  useUpdateTag,
  useDeleteTag,
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

interface TagManagerProps {
  propertyId: number;
}

interface EditState {
  name: string;
  color: string;
}

export function TagManager({ propertyId }: TagManagerProps) {
  const { data: tags = [], isLoading } = usePropertyTags(propertyId);
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [editState, setEditState] = React.useState<EditState>({ name: '', color: '' });
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const [newName, setNewName] = React.useState('');
  const [newColor, setNewColor] = React.useState(PRESET_COLORS[3]);
  const [createOpen, setCreateOpen] = React.useState(false);

  const tagList = tags as Tag[];

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setEditState({ name: tag.name, color: tag.color });
    setDeletingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function saveEdit(id: number) {
    if (!editState.name.trim()) return;
    updateTag.mutate(
      { id, name: editState.name.trim(), color: editState.color },
      {
        onSuccess: () => {
          setEditingId(null);
          toast('Tag updated');
        },
        onError: (err) => toast(err.message),
      },
    );
  }

  function confirmDelete(tag: Tag) {
    deleteTag.mutate(tag.id, {
      onSuccess: () => {
        setDeletingId(null);
        toast('Tag deleted');
      },
      onError: (err) => toast(err.message),
    });
  }

  function handleCreate() {
    if (!newName.trim()) return;
    createTag.mutate(
      { name: newName.trim(), color: newColor, propertyId },
      {
        onSuccess: () => {
          setNewName('');
          setCreateOpen(false);
          toast('Tag created');
        },
        onError: (err) => toast(err.message),
      },
    );
  }

  if (isLoading) {
    return <p className="text-xs text-[var(--color-text-muted)]">Loading tags...</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Empty state */}
      {tagList.length === 0 && !createOpen && (
        <div className="flex flex-col items-center py-6 gap-3 animate-fade-up">
          <div className="w-12 h-12 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center">
            <Tags className="w-6 h-6 text-[var(--color-primary)]" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-[var(--color-text)]">No tags yet</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Create your first tag to start organizing</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" />
            Create Tag
          </Button>
        </div>
      )}

      {/* Tag list */}
      {tagList.length > 0 && (
        <div className="flex flex-col gap-2">
          {tagList.map((tag, idx) => (
            <div
              key={tag.id}
              className="animate-fade-up rounded-[var(--radius-lg)] bg-[var(--color-elevated)] overflow-hidden transition-all duration-200"
              style={{ animationDelay: `${idx * 30}ms` }}
            >
              {editingId === tag.id ? (
                /* Inline edit mode */
                <div className="p-3 flex flex-col gap-3 animate-scale-in">
                  <Input
                    value={editState.name}
                    onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(tag.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    className="h-8 text-sm"
                    autoFocus
                  />
                  {/* Color palette strip */}
                  <div className="flex gap-1.5 items-center">
                    {PRESET_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setEditState((s) => ({ ...s, color }))}
                        className={cn(
                          'w-6 h-6 rounded-[var(--radius-sm)] transition-all duration-150 hover:scale-110',
                          editState.color === color && 'ring-2 ring-offset-2 ring-[var(--color-primary)] scale-110',
                        )}
                        style={{ backgroundColor: color }}
                        aria-label={color}
                        title={color}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveEdit(tag.id)}
                      disabled={!editState.name.trim() || updateTag.isPending}
                      className="flex-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={cancelEdit}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : deletingId === tag.id ? (
                /* Inline delete confirmation */
                <div className="p-3 flex items-center gap-3 animate-scale-in bg-[var(--color-red-bg)]">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)]">
                      Delete &ldquo;{tag.name}&rdquo;?
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      Removed from all items, containers, and areas
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => confirmDelete(tag)}
                      disabled={deleteTag.isPending}
                      className="h-7 text-xs px-2.5"
                    >
                      Delete
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDeletingId(null)}
                      className="h-7 text-xs px-2.5"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                /* Display row */
                <div className="flex items-center gap-3 p-3">
                  <div
                    className="w-4 h-4 rounded-[var(--radius-sm)] shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1 text-sm font-medium text-[var(--color-text)] truncate">
                    {tag.name}
                  </span>
                  <TagBadge tag={tag} size="sm" />
                  <div className="flex gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(tag)}
                      className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-card)] transition-all duration-150"
                      aria-label={`Edit tag ${tag.name}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeletingId(tag.id); setEditingId(null); }}
                      className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-red)] hover:bg-[var(--color-red-bg)] transition-all duration-150"
                      aria-label={`Delete tag ${tag.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create new tag */}
      {tagList.length > 0 && !createOpen && (
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center justify-center gap-2 w-full py-2.5 border border-dashed border-[var(--color-border)] rounded-[var(--radius-lg)] text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] hover:border-[var(--color-primary)]/30 transition-all duration-200 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Tag
        </button>
      )}

      {createOpen && (
        <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 flex flex-col gap-3 bg-[var(--color-card)] animate-scale-in">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--color-text)]">New Tag</p>
            <button
              type="button"
              onClick={() => { setCreateOpen(false); setNewName(''); }}
              className="p-1 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
            <div
              className="w-4 h-4 rounded-[var(--radius-sm)]"
              style={{ backgroundColor: newColor }}
            />
            <span className="text-sm text-[var(--color-text)]">
              {newName.trim() || 'Preview'}
            </span>
          </div>

          <Input
            placeholder="Tag name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="h-9"
            autoFocus
          />

          {/* Color palette strip */}
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Color</p>
            <div className="flex gap-2 items-center">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setNewColor(color)}
                  className={cn(
                    'w-7 h-7 rounded-[var(--radius-sm)] transition-all duration-150 hover:scale-110',
                    newColor === color && 'ring-2 ring-offset-2 ring-[var(--color-primary)] scale-110',
                  )}
                  style={{ backgroundColor: color }}
                  aria-label={color}
                  title={color}
                />
              ))}
            </div>
          </div>

          <Button
            type="button"
            onClick={handleCreate}
            disabled={!newName.trim() || createTag.isPending}
            className="w-full"
          >
            <Plus className="w-4 h-4" />
            Create Tag
          </Button>
        </div>
      )}
    </div>
  );
}
