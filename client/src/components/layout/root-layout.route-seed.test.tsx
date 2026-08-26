// @vitest-environment jsdom
/**
 * Regression coverage for the sidebar's container-route seeding bug (final
 * review, fix wave 3): a container's `breadcrumb` is closure-table CONTAINER
 * ancestors only — `{id, name}`, no `type` field at all — so
 * `breadcrumb.find(b => b.type === 'area' | 'property')` never matched.
 * Area/property arrive as flat `areaName` / `propertyId` fields on the
 * container payload instead (see `_mapContainer` in the server's
 * containers.service.js). The bug made "Goes in " render with a blank name
 * and `seedPropertyId` always undefined for every `/container/:id` route.
 *
 * Driven through the real `useRouteSeed` (not a re-implementation of its
 * logic) with only the two data hooks it calls mocked — following
 * create-container-dialog.test.tsx's vi.mock idiom. TypeScript can't catch
 * this class of bug because the client's `BreadcrumbItem` type carries
 * `type`, so this is exactly the kind of thing that needs a runtime check.
 */
import { render, screen } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { useRouteSeed } from './root-layout';
import { useArea, useContainer } from '@/hooks/use-inventory';

// root-layout.tsx pulls in useAuth (for Sidebar/RootLayout, neither exercised
// here) which pulls in @/store/auth-store — whose module body runs
// `applyTheme()` unconditionally at import time, calling `window.matchMedia`,
// which jsdom doesn't implement. useRouteSeed never touches auth, so the
// whole module is stubbed out rather than worked around.
vi.mock('@/store/auth-store', () => ({
  useAuthStore: vi.fn(() => ({ user: null })),
}));

vi.mock('@/hooks/use-inventory', () => ({
  useArea: vi.fn(),
  useContainer: vi.fn(),
  // Pulled in transitively via create-container-dialog.tsx's import of this
  // module; never invoked here since CreateContainerDialog isn't rendered.
  useAreas: vi.fn(),
  useCreateContainer: vi.fn(),
  useProperties: vi.fn(),
}));

function Harness({ pathname }: { pathname: string }) {
  const seed = useRouteSeed(pathname);
  return <pre data-testid="seed">{JSON.stringify(seed ?? null)}</pre>;
}

function renderedSeed() {
  return JSON.parse(screen.getByTestId('seed').textContent!);
}

test('a /container/:id route seeds from the flat areaName/propertyId fields, not the (type-less) breadcrumb', () => {
  vi.mocked(useArea).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useArea>);
  vi.mocked(useContainer).mockReturnValue({
    data: {
      id: 1,
      areaId: 7,
      // Shaped exactly like the real payload: ancestor CONTAINERS only, and
      // none of them carry a `type` field.
      breadcrumb: [{ id: 3, name: 'Parent Bin' }],
      areaName: 'Garage',
      propertyId: 42,
    },
  } as unknown as ReturnType<typeof useContainer>);

  render(<Harness pathname="/container/1" />);

  expect(renderedSeed()).toEqual({ areaId: 7, areaName: 'Garage', propertyId: 42 });
});

test('an /area/:id route still seeds from useArea directly (unaffected by the container fix)', () => {
  vi.mocked(useContainer).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useContainer>);
  vi.mocked(useArea).mockReturnValue({
    data: { id: 7, name: 'Garage', propertyId: 42 },
  } as unknown as ReturnType<typeof useArea>);

  render(<Harness pathname="/area/7" />);

  expect(renderedSeed()).toEqual({ areaId: 7, areaName: 'Garage', propertyId: 42 });
});

test('any other route seeds nothing', () => {
  vi.mocked(useArea).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useArea>);
  vi.mocked(useContainer).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useContainer>);

  render(<Harness pathname="/reports" />);

  expect(screen.getByTestId('seed').textContent).toBe('null');
});
