import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface ShareLink {
  id: number;
  token: string;
  entityType: string;
  entityId: number;
  url: string;
  expiresAt: string;
  createdAt: string;
}

export function useMyShareLinks() {
  return useQuery({
    queryKey: ['sharing', 'my-links'],
    queryFn: () => api.get<{ links: ShareLink[] }>('/api/sharing/_x_/my-links'),
    select: (data) => data.links,
  });
}

export function useCreateShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { entityType: string; entityId: number; expiresInDays?: number }) =>
      api.post<ShareLink>('/api/sharing/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing'] }),
  });
}

export function useRevokeShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/sharing/_d_/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing'] }),
  });
}
