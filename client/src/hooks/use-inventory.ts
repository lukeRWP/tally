import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';
import type { Property, Area, Container, Item } from '@/types/inventory';

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export function useProperties() {
  return useQuery({
    queryKey: queryKeys.properties.list(),
    queryFn: () => api.get<Property[]>('/api/properties/_x_/list'),
  });
}

export function useProperty(id: number) {
  return useQuery({
    queryKey: queryKeys.properties.detail(id),
    queryFn: () => api.get<Property>(`/api/properties/_x_/${id}`),
    enabled: !!id,
  });
}

export function useCreateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; address?: string; description?: string }) =>
      api.post<Property>('/api/properties/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.properties.all }),
  });
}

export function useUpdateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; address?: string; description?: string }) =>
      api.put<Property>(`/api/properties/_u_/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.properties.all }),
  });
}

export function useDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/properties/_d_/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.properties.all }),
  });
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export function useAreas(propertyId: number) {
  return useQuery({
    queryKey: queryKeys.areas.byProperty(propertyId),
    queryFn: () => api.get<Area[]>(`/api/areas/_x_/property/${propertyId}`),
    enabled: !!propertyId,
  });
}

export function useArea(id: number) {
  return useQuery({
    queryKey: queryKeys.areas.detail(id),
    queryFn: () => api.get<Area & { breadcrumb: import('@/types/inventory').BreadcrumbItem[] }>(
      `/api/areas/_x_/${id}`,
    ),
    enabled: !!id,
  });
}

export function useCreateArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string; propertyId: number }) =>
      api.post<Area>('/api/areas/_y_/create', data),
    onSuccess: (_: unknown, vars: { name: string; description?: string; propertyId: number }) =>
      qc.invalidateQueries({ queryKey: queryKeys.areas.byProperty(vars.propertyId) }),
  });
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function useContainers(areaId: number) {
  return useQuery({
    queryKey: queryKeys.containers.byArea(areaId),
    queryFn: () => api.get<Container[]>(`/api/containers/_x_/area/${areaId}`),
    enabled: !!areaId,
  });
}

export function useContainerChildren(containerId: number) {
  return useQuery({
    queryKey: queryKeys.containers.byParent(containerId),
    queryFn: () => api.get<Container[]>(`/api/containers/_x_/${containerId}/children`),
    enabled: !!containerId,
  });
}

export function useContainer(id: number) {
  return useQuery({
    queryKey: queryKeys.containers.detail(id),
    queryFn: () => api.get<Container>(`/api/containers/_x_/${id}`),
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
    }) => api.post<Container>('/api/containers/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.containers.all }),
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function useItems(containerId: number) {
  return useQuery({
    queryKey: queryKeys.items.byContainer(containerId),
    queryFn: () => api.get<Item[]>(`/api/items/_x_/container/${containerId}`),
    enabled: !!containerId,
  });
}

export function useItem(id: number) {
  return useQuery({
    queryKey: queryKeys.items.detail(id),
    queryFn: () => api.get<Item>(`/api/items/_x_/${id}`),
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
      quantity?: number;
      purchasePrice?: number;
      condition?: string;
    }) => api.post<Item>('/api/items/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.items.all }),
  });
}

export function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Record<string, unknown>) =>
      api.put<Item>(`/api/items/_u_/${id}`, data),
    onSuccess: (_: unknown, vars: { id: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.items.detail(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
    },
  });
}

export function useMoveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, containerId }: { id: number; containerId: number }) =>
      api.patch<Item>(`/api/items/_p_/${id}/move`, { containerId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.items.all }),
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
      return api.get<Item[]>(`/api/items/_x_/search?${params.toString()}`);
    },
    enabled: query.length >= 1,
  });
}
