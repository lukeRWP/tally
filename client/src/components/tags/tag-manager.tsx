import * as React from 'react';
import { Pencil, Trash2, Check, X } from 'lucide-react';
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

  const [newName, setNewName] = React.useState('');
  const [newColor, setNewColor] = React.useState(PRESET_COLORS[3]);

  const tagList = tags as Tag[];

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setEditState({ name: tag.name, color: tag.color });
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

  function handleDelete(tag: Tag) {
    if (!window.confirm(`Delete tag "${tag.name}"? It will be removed from all items, containers, and areas.`)) return;
    deleteTag.mutate(tag.id, {
      onSuccess: () => toast('Tag deleted'),
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
          toast('Tag created');
        },
        onError: (err) => toast(err.message),
      },
    );
  }

  if (isLoading) {
    return <p className="text-xs text-[var(--color-text-muted)]">Loading tags…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tag list */}
      {tagList.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">No tags yet. Create one below.</p>
      )}
      {tagList.map((tag) => (
        <div
          key={tag.id}
          className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)]"
        >
          {editingId === tag.id ? (
            /* Inline edit */
            <div className="flex-1 flex flex-col gap-2">
              <Input
                value={editState.name}
                onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit(tag.id);
                  if (e.key === 'Escape') cancelEdit();
                }}
                className="h-7 text-xs px-2"
                autoFocus
              />
              <div className="flex gap-1 flex-wrap">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setEditState((s) => ({ ...s, color }))}
                    className={cn(
                      'w-5 h-5 rounded-full transition-transform hover:scale-110',
                      editState.color === color && 'ring-2 ring-offset-1 ring-[var(--color-primary)] scale-110',
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={color}
                    title={color}
                  />
                ))}
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => saveEdit(tag.id)}
                  disabled={!editState.name.trim() || updateTag.isPending}
                  className="h-7 text-xs px-2"
                >
                  <Check className="w-3 h-3" />
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelEdit}
                  className="h-7 text-xs px-2"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* Display row */
            <>
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: tag.color }}
              />
              <span className="flex-1 text-sm text-[var(--color-text)] truncate">{tag.name}</span>
              <TagBadge tag={tag} size="sm" />
              <div className="flex gap-1 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => startEdit(tag)}
                  className="h-7 w-7"
                  aria-label={`Edit tag ${tag.name}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(tag)}
                  className="h-7 w-7 text-[var(--color-red)] hover:text-[var(--color-red)]"
                  aria-label={`Delete tag ${tag.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </>
          )}
        </div>
      ))}

      {/* Create new tag */}
      <div className="border-t border-[var(--color-border)] pt-3 flex flex-col gap-2">
        <p className="text-xs font-semibold text-[var(--color-text-secondary)]">New Tag</p>
        <Input
          placeholder="Tag name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          className="h-8 text-xs"
        />
        <div className="flex gap-1 flex-wrap">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setNewColor(color)}
              className={cn(
                'w-5 h-5 rounded-full transition-transform hover:scale-110',
                newColor === color && 'ring-2 ring-offset-1 ring-[var(--color-primary)] scale-110',
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
          onClick={handleCreate}
          disabled={!newName.trim() || createTag.isPending}
        >
          Create Tag
        </Button>
      </div>
    </div>
  );
}
