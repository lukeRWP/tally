import { Tag as TagIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TagBadgeProps {
  tag: { id: number; name: string; color: string };
  onRemove?: () => void;
  size?: 'sm' | 'md';
}

export function TagBadge({ tag, onRemove, size = 'sm' }: TagBadgeProps) {
  // Convert hex color to a background with 20% opacity using CSS
  const bg = `${tag.color}33`; // 33 ≈ 20% in hex (0.2 * 255 ≈ 51 = 0x33)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
      )}
      style={{ backgroundColor: bg, color: tag.color }}
    >
      <TagIcon
        className={cn(size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3')}
        style={{ color: tag.color }}
        aria-hidden="true"
      />
      <span>{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={cn(
            'ml-0.5 rounded-full hover:opacity-70 transition-opacity focus:outline-none',
            size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5',
          )}
          style={{ color: tag.color }}
          aria-label={`Remove tag ${tag.name}`}
        >
          <X className="w-full h-full" />
        </button>
      )}
    </span>
  );
}
