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

/**
 * One row of "what the recipient will be able to see" (#298). The catalogue is
 * served by the server (`sharing.disclosure.js`) rather than written out again
 * here, because the same table is what strips the public payload: if the
 * dialog's list and the enforcement could drift, the dialog would eventually be
 * lying. `optional: false` rows are the point of the link and have no toggle.
 */
export interface ShareDisclosureCategory {
  key: string;
  label: string;
  detail: string;
  optional: boolean;
  defaultValue: boolean;
}

/** The categories that apply to one entity type, in the server's order. */
export function useShareDisclosure(entityType: string) {
  return useQuery({
    queryKey: ['sharing', 'disclosure'],
    queryFn: () =>
      api.get<{ categories: Record<string, ShareDisclosureCategory[]> }>(
        '/api/sharing/_x_/disclosure',
      ),
    select: (data) => data.categories[entityType] ?? [],
    staleTime: Infinity,
  });
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
    mutationFn: (data: {
      entityType: string;
      entityId: number;
      expiresInDays?: number;
      // Omitted means "every category", which is what a link published before
      // this existed — so an untouched dialog creates exactly the old link.
      disclosure?: Record<string, boolean>;
    }) => api.post<ShareLink>('/api/sharing/_y_/create', data),
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
