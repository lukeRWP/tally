import * as React from 'react';
import { useNavigate } from 'react-router';
import { Package } from 'lucide-react';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentActivity, type AuditEntry } from '@/hooks/use-notifications';
import { cn } from '@/lib/utils';

// Which activity entries can be tapped through to their entity.
const ACTIVITY_ROUTES: Record<string, string> = {
  item: '/item',
  container: '/container',
  area: '/area',
  property: '/property',
};

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
  // The server's recent-activity query never joins an entity name, so
  // changes.name is only present when the change payload happened to carry
  // one. Falling back to the entity TYPE prints it twice — "updated
  // container container". The id is at least identifying.
  const name = typeof entry.changes?.name === 'string' ? entry.changes.name : `#${entry.entityId}`;
  return (
    <span>
      {entry.displayName} {entry.action} {entry.entityType} <span className="font-semibold text-[var(--color-text)]">{name}</span>
    </span>
  );
}

/**
 * The only cross-entity, cross-property history in the app: who moved, deleted
 * or restored what, anywhere in the house. Per-entity history answers "what
 * happened to THIS item", which requires already suspecting the item; this is
 * what you read when something has gone missing and you don't know where to
 * start looking. It belongs beside the loans and notifications because all
 * three answer the same question — what changed while I wasn't watching.
 */
export function RecentActivity() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = React.useState(false);
  const { data: recentActivity, isLoading } = useRecentActivity();

  const entries = recentActivity?.slice(0, 10) ?? [];
  const visibleEntries = expanded ? entries : entries.slice(0, 3);

  // Group by day so a burst of edits reads as one session rather than ten
  // unrelated lines.
  const visibleByDay: Array<{ label: string; entries: AuditEntry[] }> = [];
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
    <section className="max-w-2xl mx-auto w-full flex flex-col">
      <ColHead>Recent activity{entries.length > 0 ? ` · ${entries.length}` : ''}</ColHead>

      {isLoading && (
        <div className="flex flex-col gap-2 mt-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <div className="flex flex-col items-center py-6 gap-2">
          <Package className="w-8 h-8 text-[var(--color-text-muted)]" />
          <p className="text-sm text-[var(--color-text-muted)] text-center">No recent activity</p>
        </div>
      )}

      {!isLoading && entries.length > 0 && (
        <div className="flex flex-col gap-0">
          {visibleByDay.map((group, gIdx) => (
            <div key={group.label}>
              {/* Day divider */}
              <div className={cn('flex items-center gap-2 py-1.5', gIdx > 0 && 'mt-2')}>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {group.label}
                </span>
                <div className="flex-1 h-px bg-[var(--color-border)]" />
              </div>

              {group.entries.map((entry, idx) => (
                // The feed is a set of jump-offs, not a read-only log: every
                // line raises a question ("moved WHERE?") whose answer is the
                // entity itself, so the row goes there. Unknown entity types
                // have nowhere to send you and stay inert.
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
                  <span className={cn('flex-shrink-0 mt-1.5 w-2 h-2 rounded-full', activityDotColor(entry.action))} />
                  <span className="flex-1 text-[var(--color-text-secondary)] line-clamp-1">
                    {activityLabel(entry)}
                  </span>
                  <span className="flex-shrink-0 font-mono text-[var(--color-text-muted)]">
                    {activityRelativeTime(entry.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ))}

          {entries.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-[var(--color-primary)] mt-2 text-left hover:underline"
            >
              {expanded ? 'Show less' : `Show ${entries.length - 3} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
