import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';

export interface MatchCandidate {
  name: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  priceUsd: number | null;
  imageUrl: string | null;
  sourceUrl: string;
  sourceDomain: string;
}

export type MatchStatus = 'queued' | 'searching' | 'ready' | 'none' | 'failed';

export interface ProductMatch {
  id: number;
  itemId: number;
  itemName: string;
  containerName: string;
  status: MatchStatus;
  candidates: MatchCandidate[];
  lastError: string | null;
  createdAt: string;
}

export interface ResolveMatchResult {
  product: { id: number; name: string; brand: string | null; barcode: string | null } | null;
  duplicates: Array<{ id: number; name: string; containerName: string; areaName: string; propertyName: string }>;
}

export const matchKeys = {
  list: (propertyId: number) => ['matches', propertyId] as const,
};

export function useMatches(propertyId?: number) {
  return useQuery({
    queryKey: matchKeys.list(propertyId ?? 0),
    queryFn: () => api.get<ProductMatch[]>(`/api/products/_x_/matches?propertyId=${propertyId}`),
    enabled: !!propertyId,
    // Poll only while something is still being worked. A worklist of settled
    // rows is static, and polling it forever is just noise on the server.
    refetchInterval: (query) => {
      const rows = query.state.data as ProductMatch[] | undefined;
      const working = rows?.some((m) => m.status === 'queued' || m.status === 'searching');
      return working ? 5000 : false;
    },
  });
}

export function useResolveMatch(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; candidateIndex?: number; dismiss?: boolean }) =>
      api.post<ResolveMatchResult>(`/api/products/_y_/matches/${vars.id}/resolve`,
        vars.dismiss ? { dismiss: true } : { candidateIndex: vars.candidateIndex }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: matchKeys.list(propertyId ?? 0) });
      // The item now has a product; anything showing items is stale.
      qc.invalidateQueries({ queryKey: ['items'] });
    },
    onError: (err) => {
      // 409 means someone else — another tab, another person in the
      // household — already resolved or dismissed this match. The row is no
      // longer queued/searching, so useMatches' own polling has already
      // stopped and will never rescue it: without this, the stale row (and
      // its now-wrong candidate panel) would sit in the list until the next
      // manual refresh. Invalidate so it clears itself. Any other error
      // (network blip, 500) is left alone — the list stays exactly as the
      // user was looking at it.
      if (err instanceof ApiError && err.status === 409) {
        qc.invalidateQueries({ queryKey: matchKeys.list(propertyId ?? 0) });
      }
    },
  });
}

export function useQueueMatch() {
  return useMutation({
    mutationFn: (vars: {
      itemId: number; brand: string; name: string;
      category?: string | null; description?: string | null;
    }) => api.post('/api/products/_y_/matches', vars),
  });
}
