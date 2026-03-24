import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemDate {
  id: number;
  itemId: number;
  dateType: string;
  dateValue: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  itemName?: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useItemDates(itemId: number) {
  return useQuery({
    queryKey: queryKeys.dates.byItem(itemId),
    queryFn: () =>
      api
        .get<{ dates: ItemDate[] }>(`/api/dates/_x_/item/${itemId}`)
        .then((d) => d.dates),
    enabled: !!itemId,
  });
}

export function useUpcomingDates() {
  return useQuery({
    queryKey: queryKeys.dates.upcoming(),
    queryFn: () =>
      api
        .get<{ dates: ItemDate[] }>('/api/dates/_x_/upcoming')
        .then((d) => d.dates),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      dateType,
      dateValue,
      notes,
    }: {
      itemId: number;
      dateType: string;
      dateValue: string;
      notes?: string;
    }) =>
      api.post<{ date: ItemDate }>(`/api/dates/_y_/item/${itemId}`, {
        dateType,
        dateValue,
        notes: notes || undefined,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.dates.byItem(vars.itemId) });
    },
  });
}

export function useUpdateDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      dateId,
      dateType,
      dateValue,
      notes,
    }: {
      dateId: number;
      itemId: number;
      dateType?: string;
      dateValue?: string;
      notes?: string;
    }) =>
      api.put<{ date: ItemDate }>(`/api/dates/_u_/${dateId}`, {
        dateType,
        dateValue,
        notes,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.dates.byItem(vars.itemId) });
    },
  });
}

export function useDeleteDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dateId }: { dateId: number; itemId: number }) =>
      api.del(`/api/dates/_d_/${dateId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.dates.byItem(vars.itemId) });
    },
  });
}
