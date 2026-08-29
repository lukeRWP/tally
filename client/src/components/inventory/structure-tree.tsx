import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Package, Box } from 'lucide-react';
import type { Area, Container } from '@/types/inventory';
import { cn } from '@/lib/utils';

/**
 * A property's shape in one screen: areas, their bins, and bins inside bins.
 *
 * Deliberately stops at containers. Items are what search is for — a property
 * with three hundred of them turns a structural view into a wall, and "where
 * does this live" is a question about bins, not about every object in them.
 *
 * The whole tree arrives in a single request (usePropertyTree), so expanding is
 * pure state with no fetch. Level-by-level loading would be one request per
 * node, which is invisible on a demo property and painful on a real one.
 */

/** How far to indent each level. Small — depth reads from the rule, not a gap. */
const INDENT = 14;

export interface TreeNode {
  container: Container;
  children: TreeNode[];
}

/** Assemble the flat rows into a forest, keyed by area. */
export function buildTree(containers: Container[]): Map<number, TreeNode[]> {
  const nodes = new Map<number, TreeNode>();
  for (const c of containers) nodes.set(c.id, { container: c, children: [] });

  const byArea = new Map<number, TreeNode[]>();
  for (const c of containers) {
    const node = nodes.get(c.id)!;
    if (c.parentContainerId != null) {
      const parent = nodes.get(c.parentContainerId);
      // A parent outside this property, or soft-deleted, would orphan the node.
      // Surfacing it at area level beats dropping it silently: an invisible bin
      // is worse than one shown in a slightly wrong place.
      if (parent) { parent.children.push(node); continue; }
    }
    const list = byArea.get(c.areaId) || [];
    list.push(node);
    byArea.set(c.areaId, list);
  }
  return byArea;
}

function ContainerRow({ node, depth, expanded, onToggle, onSelect, selectedId }: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  onToggle: (id: number) => void;
  onSelect?: (containerId: number) => void;
  selectedId?: number | null;
}) {
  const navigate = useNavigate();
  const { container } = node;
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(container.id);

  return (
    <>
      <div
        // The keyboard ring's scroll target (#235): areas.tsx passes this same
        // id to useNavScrollIntoView, so a j/k move keeps the row on screen.
        data-nav-id={container.id}
        className="flex items-center gap-1 min-h-[44px] border-b border-[var(--color-rule)]"
        style={{ paddingLeft: depth * INDENT }}
      >
        {/* A fixed-width slot whether or not there is a chevron, so names on the
            same level line up regardless of which bins have children. */}
        <button
          type="button"
          aria-label={hasChildren ? (isOpen ? `Collapse ${container.name}` : `Expand ${container.name}`) : undefined}
          aria-expanded={hasChildren ? isOpen : undefined}
          disabled={!hasChildren}
          onClick={() => onToggle(container.id)}
          className="w-8 h-11 shrink-0 flex items-center justify-center disabled:opacity-0"
        >
          <ChevronRight className={cn('w-4 h-4 transition-transform', isOpen && 'rotate-90')} />
        </button>

        <button
          type="button"
          // Selecting keeps the tree on screen beside the contents; navigating
          // replaces it. Which one happens is the page's call, not this row's.
          onClick={() => (onSelect ? onSelect(container.id) : navigate(`/container/${container.id}`))}
          aria-current={selectedId === container.id ? 'true' : undefined}
          className={cn(
            'min-w-0 flex-1 text-left py-1.5 px-2 rounded-[var(--radius-sm)]',
            selectedId === container.id && 'bg-[var(--color-text)] text-[var(--color-bg)]',
          )}
        >
          <span className="block truncate text-sm font-semibold">{container.name}</span>
          <span className={cn(
            'block font-mono text-[10px] uppercase tracking-[0.06em]',
            selectedId === container.id ? 'text-[var(--color-bg)] opacity-80' : 'text-[var(--color-text-muted)]',
          )}>
            {container.type}
            {container.itemCount > 0 && ` · ${container.itemCount} item${container.itemCount === 1 ? '' : 's'}`}
            {hasChildren && ` · ${node.children.length} bin${node.children.length === 1 ? '' : 's'}`}
          </span>
        </button>
        <Box className="w-4 h-4 shrink-0 text-[var(--color-text-muted)] mr-1" />
      </div>

      {isOpen && node.children.map((child) => (
        <ContainerRow key={child.container.id} node={child} depth={depth + 1}
          expanded={expanded} onToggle={onToggle} onSelect={onSelect} selectedId={selectedId} />
      ))}
    </>
  );
}

export function StructureTree({ areas, containers, onSelect, selectedId, onVisibleOrder }: {
  areas: Area[];
  containers: Container[];
  /** Supplied by a master-detail layout; without it, rows navigate as before. */
  onSelect?: (containerId: number) => void;
  selectedId?: number | null;
  /** The bin ids currently on screen, top to bottom — what j/k walks. */
  onVisibleOrder?: (ids: number[]) => void;
}) {
  const navigate = useNavigate();
  const byArea = React.useMemo(() => buildTree(containers), [containers]);
  // Areas open by default: the point of this view is seeing the shape, and a
  // screen of collapsed rows shows less than the list it replaced.
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [closedAreas, setClosedAreas] = React.useState<Set<number>>(new Set());

  /**
   * The ids actually on screen, derived from the same maps the rows render
   * from and in the same order. Computing this independently would drift the
   * moment a row's visibility rule changed, and the selection would jump to a
   * bin the user cannot see.
   */
  const visibleOrder = React.useMemo(() => {
    const out: number[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.container.id);
        if (expanded.has(n.container.id)) walk(n.children);
      }
    };
    for (const area of areas) {
      if (!closedAreas.has(area.id)) walk(byArea.get(area.id) || []);
    }
    return out;
  }, [areas, byArea, expanded, closedAreas]);

  React.useEffect(() => { onVisibleOrder?.(visibleOrder); }, [visibleOrder, onVisibleOrder]);

  const toggle = React.useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col">
      {areas.map((area) => {
        const roots = byArea.get(area.id) || [];
        const areaOpen = !closedAreas.has(area.id);
        return (
          <React.Fragment key={area.id}>
            <div className="flex items-center gap-1 min-h-[44px] border-b border-[var(--color-text)]">
              <button
                type="button"
                aria-label={areaOpen ? `Collapse ${area.name}` : `Expand ${area.name}`}
                aria-expanded={areaOpen}
                disabled={roots.length === 0}
                onClick={() => setClosedAreas((prev) => {
                  const next = new Set(prev);
                  if (next.has(area.id)) next.delete(area.id); else next.add(area.id);
                  return next;
                })}
                className="w-8 h-11 shrink-0 flex items-center justify-center disabled:opacity-0"
              >
                <ChevronRight className={cn('w-4 h-4 transition-transform', areaOpen && 'rotate-90')} />
              </button>
              <button
                type="button"
                onClick={() => navigate(`/area/${area.id}`)}
                className="min-w-0 flex-1 text-left py-2"
              >
                <span className="block truncate text-sm font-bold uppercase tracking-[0.06em]">{area.name}</span>
                <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                  {roots.length === 0 ? 'no bins yet' : `${area.containerCount} bin${area.containerCount === 1 ? '' : 's'} · ${area.itemCount} item${area.itemCount === 1 ? '' : 's'}`}
                </span>
              </button>
              <Package className="w-4 h-4 shrink-0 text-[var(--color-text-muted)] mr-1" />
            </div>

            {areaOpen && roots.map((node) => (
              <ContainerRow key={node.container.id} node={node} depth={1}
                expanded={expanded} onToggle={toggle} onSelect={onSelect} selectedId={selectedId} />
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}
