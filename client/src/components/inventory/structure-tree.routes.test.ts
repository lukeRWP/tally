/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import appSource from '../../App.tsx?raw';
import treeSource from './structure-tree.tsx?raw';

/**
 * Every route a component navigates to must actually exist.
 *
 * TypeScript cannot check this — a path is just a string — and React Router's
 * catch-all turns a typo into a silent redirect Home rather than an error. The
 * nested view shipped navigating to `/containers/:id` and `/areas/:id`. Both
 * plural, both undeclared, both landing on Home; every row in the tree was
 * dead and nothing anywhere said why.
 *
 * The trap is that the LIST page IS plural (`/areas`) while the DETAIL route
 * is singular (`/area/:areaId`), so the wrong path looks right next to the
 * one it was copied from.
 *
 * Reading source as text is blunt, but the alternative is mounting a router in
 * every component test, and this catches the exact class that got through.
 */

/** Route paths declared in App.tsx, as first segments: '/area/:areaId' -> '/area'. */
const declared = new Set(
  [...appSource.matchAll(/path="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith('/'))
    .map((p) => '/' + p.split('/')[1])
);

/** Template-literal navigate targets: navigate(`/container/${x}`) -> '/container'. */
const used = [...treeSource.matchAll(/navigate\(`(\/[a-zA-Z-]+)\//g)].map((m) => m[1]);

describe('structure-tree navigation', () => {
  it('only navigates to routes App.tsx actually declares', () => {
    expect(used.length).toBeGreaterThan(0);
    for (const path of used) {
      expect(
        declared,
        `${path} is not a declared route — the catch-all sends this Home`
      ).toContain(path);
    }
  });

  it('uses the singular entity paths, not the plural list paths', () => {
    expect(used).toContain('/container');
    expect(used).toContain('/area');
    expect(used).not.toContain('/containers');
    expect(used).not.toContain('/areas');
  });
});
