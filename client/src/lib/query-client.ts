import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: (failureCount, error) => {
        if (error instanceof Error && error.message.includes('401')) return false;
        return failureCount < 3;
      },
    },
  },
});

export const queryKeys = {
  properties: {
    all: ['properties'] as const,
    list: () => [...queryKeys.properties.all, 'list'] as const,
    detail: (id: number) => [...queryKeys.properties.all, 'detail', id] as const,
    members: (id: number) => [...queryKeys.properties.all, 'members', id] as const,
  },
  areas: {
    all: ['areas'] as const,
    byProperty: (propertyId: number) => [...queryKeys.areas.all, 'byProperty', propertyId] as const,
    detail: (id: number) => [...queryKeys.areas.all, 'detail', id] as const,
  },
  containers: {
    all: ['containers'] as const,
    byArea: (areaId: number) => [...queryKeys.containers.all, 'byArea', areaId] as const,
    byParent: (parentId: number) => [...queryKeys.containers.all, 'byParent', parentId] as const,
    detail: (id: number) => [...queryKeys.containers.all, 'detail', id] as const,
    allItems: (id: number) => [...queryKeys.containers.all, 'allItems', id] as const,
  },
  items: {
    all: ['items'] as const,
    byContainer: (containerId: number) => [...queryKeys.items.all, 'byContainer', containerId] as const,
    detail: (id: number) => [...queryKeys.items.all, 'detail', id] as const,
    search: (q: string) => [...queryKeys.items.all, 'search', q] as const,
  },
  auth: {
    session: ['auth', 'session'] as const,
  },
  files: {
    all: ['files'] as const,
    byItem: (itemId: number) => [...queryKeys.files.all, 'byItem', itemId] as const,
  },
  conditions: {
    all: ['conditions'] as const,
    byItem: (itemId: number) => [...queryKeys.conditions.all, 'byItem', itemId] as const,
  },
  products: {
    all: ['products'] as const,
    detail: (id: number) => [...queryKeys.products.all, 'detail', id] as const,
    barcode: (barcode: string) => [...queryKeys.products.all, 'barcode', barcode] as const,
    search: (q: string) => [...queryKeys.products.all, 'search', q] as const,
  },
  tags: {
    all: ['tags'] as const,
    byProperty: (propertyId: number) => [...queryKeys.tags.all, 'byProperty', propertyId] as const,
    forEntity: (entityType: string, entityId: number) => [...queryKeys.tags.all, 'entity', entityType, entityId] as const,
  },
  labels: {
    all: ['labels'] as const,
  },
};
