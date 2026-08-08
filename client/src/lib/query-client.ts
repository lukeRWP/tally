import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: (failureCount, error) => {
        // Never retry client errors (auth/validation/not-found) — the old check
        // looked for '401' in the message, which the server never sends, so
        // every expired session was retried 3x before failing. Only retry
        // transient server/network errors, and only briefly.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
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
    search: (q: string, filters?: unknown) => [...queryKeys.items.all, 'search', q, filters] as const,
    // Nested under items.all so the prefix-matching invalidation every item
    // mutation already performs reaches it — a newly added thing has to appear
    // at the top of Home without anyone remembering to wire it up.
    recent: (limit: number) => [...queryKeys.items.all, 'recent', limit] as const,
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
  notifications: {
    all: ['notifications'] as const,
    list: () => [...queryKeys.notifications.all, 'list'] as const,
    unreadCount: () => [...queryKeys.notifications.all, 'unreadCount'] as const,
    preferences: () => [...queryKeys.notifications.all, 'preferences'] as const,
  },
  audit: {
    all: ['audit'] as const,
    byProperty: (propertyId: number) => [...queryKeys.audit.all, 'byProperty', propertyId] as const,
    recent: () => [...queryKeys.audit.all, 'recent'] as const,
  },
  lending: {
    all: ['lending'] as const,
    byItem: (itemId: number) => [...queryKeys.lending.all, 'byItem', itemId] as const,
    active: (itemId: number) => [...queryKeys.lending.all, 'active', itemId] as const,
    overdue: () => [...queryKeys.lending.all, 'overdue'] as const,
    // House-wide active list (distinct from per-item `active(itemId)`).
    activeAll: () => [...queryKeys.lending.all, 'activeAll'] as const,
  },
  dates: {
    all: ['dates'] as const,
    byItem: (itemId: number) => [...queryKeys.dates.all, 'byItem', itemId] as const,
    upcoming: () => [...queryKeys.dates.all, 'upcoming'] as const,
  },
  accessories: {
    all: ['accessories'] as const,
    byItem: (itemId: number) => [...queryKeys.accessories.all, 'byItem', itemId] as const,
  },
};
