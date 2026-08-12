import { describe, it, expect } from 'vitest';
import { buildTree } from './structure-tree';
import type { Container } from '@/types/inventory';

/**
 * Assembling a flat container list into a forest.
 *
 * Exported purely so it can be tested — the tree-building is the part with
 * edge cases (orphans, ordering, depth), and it is the part a visual check of
 * the component would not reliably catch.
 */
const c = (over: Partial<Container> & { id: number; areaId: number }): Container => ({
  parentContainerId: null, name: `Bin ${over.id}`, type: 'box', description: null,
  qrCode: `TLY-C-${over.id}`, containerCount: 0, itemCount: 0, breadcrumb: [], ...over,
} as Container);

describe('buildTree', () => {
  it('groups top-level containers under their area', () => {
    const byArea = buildTree([c({ id: 1, areaId: 5 }), c({ id: 2, areaId: 6 })]);
    expect(byArea.get(5)!.map((n) => n.container.id)).toEqual([1]);
    expect(byArea.get(6)!.map((n) => n.container.id)).toEqual([2]);
  });

  it('nests a child under its parent rather than at area level', () => {
    const byArea = buildTree([
      c({ id: 1, areaId: 5 }),
      c({ id: 2, areaId: 5, parentContainerId: 1 }),
    ]);
    const roots = byArea.get(5)!;
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((n) => n.container.id)).toEqual([2]);
  });

  it('nests arbitrarily deep', () => {
    const byArea = buildTree([
      c({ id: 1, areaId: 5 }),
      c({ id: 2, areaId: 5, parentContainerId: 1 }),
      c({ id: 3, areaId: 5, parentContainerId: 2 }),
      c({ id: 4, areaId: 5, parentContainerId: 3 }),
    ]);
    let node = byArea.get(5)![0];
    const chain = [node.container.id];
    while (node.children.length) { node = node.children[0]; chain.push(node.container.id); }
    expect(chain).toEqual([1, 2, 3, 4]);
  });

  it('surfaces an orphan at area level instead of dropping it', () => {
    // A parent that is soft-deleted or outside this property. An invisible bin
    // is worse than one shown slightly high — you cannot fix what you cannot see.
    const byArea = buildTree([c({ id: 2, areaId: 5, parentContainerId: 999 })]);
    expect(byArea.get(5)!.map((n) => n.container.id)).toEqual([2]);
  });

  it('does not care what order the rows arrive in', () => {
    // The query orders by name, so a child can precede its parent.
    const byArea = buildTree([
      c({ id: 2, areaId: 5, parentContainerId: 1 }),
      c({ id: 1, areaId: 5 }),
    ]);
    const roots = byArea.get(5)!;
    expect(roots.map((n) => n.container.id)).toEqual([1]);
    expect(roots[0].children.map((n) => n.container.id)).toEqual([2]);
  });

  it('places each container exactly once', () => {
    const rows = [
      c({ id: 1, areaId: 5 }),
      c({ id: 2, areaId: 5, parentContainerId: 1 }),
      c({ id: 3, areaId: 5, parentContainerId: 1 }),
      c({ id: 4, areaId: 6 }),
    ];
    const byArea = buildTree(rows);
    const seen: number[] = [];
    const walk = (n: { container: Container; children: unknown[] }) => {
      seen.push(n.container.id);
      (n.children as { container: Container; children: unknown[] }[]).forEach(walk);
    };
    [...byArea.values()].flat().forEach(walk);
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });

  it('returns an empty map for no containers', () => {
    expect(buildTree([]).size).toBe(0);
  });
});
