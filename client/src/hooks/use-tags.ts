import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

export interface Tag {
  id: number;
  name: string;
  color: string;
  propertyId: number;
}

export function usePropertyTags(propertyId: number) {
  return useQuery({
    queryKey: queryKeys.tags.byProperty(propertyId),
    queryFn: () => api.get<{ tags: Tag[] }>(`/api/tags/_x_/property/${propertyId}`),
    select: (data) => (data as unknown as { tags: Tag[] }).tags ?? (data as unknown as Tag[]),
    enabled: !!propertyId,
  });
}

export function useEntityTags(entityType: string, entityId: number) {
  return useQuery({
    queryKey: queryKeys.tags.forEntity(entityType, entityId),
    queryFn: () => api.get<{ tags: Tag[] }>(`/api/tags/_x_/entity/${entityType}/${entityId}`),
    select: (data) => (data as unknown as { tags: Tag[] }).tags ?? (data as unknown as Tag[]),
    enabled: !!entityId,
  });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; color: string; propertyId: number }) =>
      api.post<{ tag: Tag }>('/api/tags/_y_/create', data),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: queryKeys.tags.byProperty(vars.propertyId) }),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; color?: string }) =>
      api.put<{ tag: Tag }>(`/api/tags/_u_/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tags.all }),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/tags/_d_/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tags.all }),
  });
}

export function useAddTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { tagId: number; entityType: string; entityId: number }) =>
      api.post('/api/tags/_y_/entity', data),
    onSuccess: (_, vars) =>
      qc.invalidateQueries({ queryKey: queryKeys.tags.forEntity(vars.entityType, vars.entityId) }),
  });
}

export function useRemoveTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, entityType, entityId }: { tagId: number; entityType: string; entityId: number }) =>
      api.del(`/api/tags/_d_/entity/${tagId}/${entityType}/${entityId}`),
    onSuccess: (_, vars) =>
      qc.invalidateQueries({ queryKey: queryKeys.tags.forEntity(vars.entityType, vars.entityId) }),
  });
}
