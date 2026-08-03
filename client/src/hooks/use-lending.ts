import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LendingRecord {
  id: number;
  itemId: number;
  lentTo: string;
  lentAt: string;
  dueAt: string | null;
  returnedAt: string | null;
  notes: string | null;
  createdBy: number;
  itemName?: string;
  containerName?: string;
  areaName?: string;
  propertyName?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useLendingHistory(itemId: number) {
  return useQuery({
    queryKey: queryKeys.lending.byItem(itemId),
    queryFn: () =>
      api
        .get<{ history: LendingRecord[] }>(`/api/lending/_x_/item/${itemId}`)
        .then((d) => d.history),
    enabled: !!itemId,
  });
}

export function useActiveLending(itemId: number) {
  return useQuery({
    queryKey: queryKeys.lending.active(itemId),
    queryFn: () =>
      api
        .get<{ lending: LendingRecord | null }>(`/api/lending/_x_/item/${itemId}/active`)
        .then((d) => d.lending),
    enabled: !!itemId,
  });
}

export function useOverdueItems() {
  return useQuery({
    queryKey: queryKeys.lending.overdue(),
    queryFn: () =>
      api
        .get<{ overdue: LendingRecord[] }>('/api/lending/_x_/overdue')
        .then((d) => d.overdue),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useLendItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      lentTo,
      dueAt,
      notes,
    }: {
      itemId: number;
      lentTo: string;
      dueAt?: string;
      notes?: string;
    }) =>
      api.post<{ lending: LendingRecord }>(`/api/lending/_y_/item/${itemId}/lend`, {
        lentTo,
        dueAt: dueAt || undefined,
        notes: notes || undefined,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.lending.byItem(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.lending.active(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.items.detail(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.items.all }); // STATUS changed → list/search/badges
    },
  });
}

export function useReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lendingId }: { lendingId: number; itemId: number }) =>
      api.patch<{ lending: LendingRecord }>(`/api/lending/_p_/${lendingId}/return`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.lending.byItem(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.lending.active(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.items.detail(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.items.all }); // STATUS changed → list/search/badges
    },
  });
}
