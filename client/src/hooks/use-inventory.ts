import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';
import type { Property, Area, Container, Item, BreadcrumbItem } from '@/types/inventory';

// Helper: API responses wrap data in named keys like { properties: [...] }
// These select functions unwrap them for the components.

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Anything that changes WHERE something lives, or whether it exists, moves a
 * count that is denormalised onto its ancestors: containers and areas carry
 * itemCount, areas and properties carry containerCount. Invalidating only the
 * entity's own key family leaves those ancestor rows rendering stale numbers
 * for the whole staleTime window, so every create / delete / move invalidates
 * the tree rather than one level of it.
 */
function invalidateTree(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.items.all });
  qc.invalidateQueries({ queryKey: queryKeys.containers.all });
  qc.invalidateQueries({ queryKey: queryKeys.areas.all });
  qc.invalidateQueries({ queryKey: queryKeys.properties.all });
}

export function useProperties() {
  return useQuery({
    queryKey: queryKeys.properties.list(),
    queryFn: () => api.get<{ properties: Property[] }>('/api/properties/_x_/list'),
    select: (data) => data.properties,
  });
}

export function useProperty(id: number) {
  return useQuery({
    queryKey: queryKeys.properties.detail(id),
    queryFn: () => api.get<{ property: Property }>(`/api/properties/_x_/${id}`),
    select: (data) => data.property,
    enabled: !!id,
  });
}

export function useCreateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; address?: string; description?: string }) =>
      api.post<{ property: Property }>('/api/properties/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.properties.all }),
  });
}

export function useUpdateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; address?: string; description?: string }) =>
      api.put<{ property: Property }>(`/api/properties/_u_/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.properties.all }),
  });
}

export function useDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/properties/_d_/${id}`),
    // Deleting a property cascades to its areas, containers and items server
    // side, so every level below it is stale, not just the property list.
    onSuccess: () => invalidateTree(qc),
  });
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export function useAreas(propertyId: number) {
  return useQuery({
    queryKey: queryKeys.areas.byProperty(propertyId),
    queryFn: () => api.get<{ areas: Area[] }>(`/api/areas/_x_/property/${propertyId}`),
    select: (data) => data.areas,
    enabled: !!propertyId,
  });
}

export function useArea(id: number) {
  return useQuery({
    queryKey: queryKeys.areas.detail(id),
    queryFn: () => api.get<{ area: Area & { breadcrumb: BreadcrumbItem[]; propertyName: string } }>(
      `/api/areas/_x_/${id}`,
    ),
    select: (data) => data.area,
    enabled: !!id,
  });
}

export function useDeleteArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/areas/_d_/${id}`),
    // Cascades to the area's containers and their items server side, so those
    // caches would otherwise keep rendering rows that are now in the bin.
    onSuccess: () => invalidateTree(qc),
  });
}

export function useCreateArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string; propertyId: number }) =>
      api.post<{ area: Area }>('/api/areas/_y_/create', data),
    onSuccess: (_: unknown, vars: { name: string; description?: string; propertyId: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.areas.byProperty(vars.propertyId) });
      // Also refresh property queries so the server-computed AREA_COUNT updates
      // (property cards / detail / home totals), matching useDeleteArea.
      qc.invalidateQueries({ queryKey: queryKeys.properties.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function useContainers(areaId: number) {
  return useQuery({
    queryKey: queryKeys.containers.byArea(areaId),
    queryFn: () => api.get<{ containers: Container[] }>(`/api/containers/_x_/area/${areaId}`),
    select: (data) => data.containers,
    enabled: !!areaId,
  });
}

export function useContainerChildren(containerId: number) {
  return useQuery({
    queryKey: queryKeys.containers.byParent(containerId),
    queryFn: () => api.get<{ containers: Container[] }>(`/api/containers/_x_/${containerId}/children`),
    select: (data) => data.containers,
    enabled: !!containerId,
  });
}

export function useContainer(id: number) {
  return useQuery({
    queryKey: queryKeys.containers.detail(id),
    queryFn: () => api.get<{ container: Container }>(`/api/containers/_x_/${id}`),
    select: (data) => data.container,
    enabled: !!id,
  });
}

export function useCreateContainer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      type: string;
      description?: string;
      areaId: number;
      parentContainerId?: number;
    }) => api.post<{ container: Container }>('/api/containers/_y_/create', data),
    // Area and property rows carry containerCount, and a nested bin also moves
    // its parent's count — so the whole tree, not just the container family.
    onSuccess: () => invalidateTree(qc),
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function useItems(containerId: number) {
  return useQuery({
    queryKey: queryKeys.items.byContainer(containerId),
    queryFn: () => api.get<{ items: Item[] }>(`/api/items/_x_/container/${containerId}`),
    select: (data) => data.items,
    enabled: !!containerId,
  });
}

export function useItem(id: number) {
  return useQuery({
    queryKey: queryKeys.items.detail(id),
    queryFn: () => api.get<{ item: Item }>(`/api/items/_x_/${id}`),
    select: (data) => data.item,
    enabled: !!id,
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      containerId: number;
      productId?: number;
      quantity?: number;
      purchasePrice?: number;
      condition?: string;
    }) => api.post<{ item: Item }>('/api/items/_y_/create', data),
    // Same reason as useMoveItem: container and area rows carry itemCount, so
    // adding an item without invalidating them leaves those counts stale.
    onSuccess: () => invalidateTree(qc),
  });
}

export function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Record<string, unknown>) =>
      api.put<{ item: Item }>(`/api/items/_u_/${id}`, data),
    onSuccess: (_: unknown, vars: { id: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.items.detail(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
    },
  });
}

/**
 * Move a container: nest it under another container (parentContainerId), or
 * re-home it to an area's top level (parentContainerId null + areaId). The
 * server owns the cycle guard — a container cannot land inside its own subtree.
 */
export function useMoveContainer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentContainerId, areaId }: {
      id: number; parentContainerId: number | null; areaId?: number;
    }) =>
      api.patch<{ container: Container }>(`/api/containers/_p_/${id}/move`, {
        parentContainerId,
        ...(areaId ? { areaId } : {}),
      }),
    onSuccess: () => {
      // Re-parenting moves a whole subtree, so item lists shift too.
      qc.invalidateQueries({ queryKey: queryKeys.containers.all });
      qc.invalidateQueries({ queryKey: queryKeys.areas.all });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
    },
  });
}

export function useMoveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, containerId }: { id: number; containerId: number }) =>
      api.patch<{ item: Item }>(`/api/items/_p_/${id}/move`, { containerId }),
    onSuccess: () => {
      // A move changes TWO containers, and container/area rows carry itemCount
      // and containerCount — invalidating only items.all left those counts
      // stale, so a moved item appeared to be in both places at once.
      invalidateTree(qc);
    },
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/items/_d_/${id}`),
    onSuccess: () => invalidateTree(qc),
  });
}

export interface SearchFilters {
  tagIds?: number[];
  condition?: string;
  status?: string;
}

export function useSearchItems(query: string, filters?: SearchFilters) {
  return useQuery({
    queryKey: queryKeys.items.search(query, filters),
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (filters?.tagIds && filters.tagIds.length > 0) {
        params.set('tagIds', filters.tagIds.join(','));
      }
      if (filters?.condition) params.set('condition', filters.condition);
      if (filters?.status) params.set('status', filters.status);
      return api.get<{ items: Item[] }>(`/api/items/_x_/search?${params.toString()}`);
    },
    select: (data) => data.items,
    enabled: query.length >= 1,
  });
}
