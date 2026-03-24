import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Accessory {
  itemId: number;
  accessoryId: number;
  createdAt: string;
  name: string | null;
  qrCode: string | null;
  condition: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useAccessories(itemId: number) {
  return useQuery({
    queryKey: queryKeys.accessories.byItem(itemId),
    queryFn: () =>
      api
        .get<{ accessories: Accessory[] }>(`/api/accessories/_x_/item/${itemId}`)
        .then((d) => d.accessories),
    enabled: !!itemId,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useLinkAccessory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, accessoryId }: { itemId: number; accessoryId: number }) =>
      api.post(`/api/accessories/_y_/item/${itemId}/link`, { accessoryId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.accessories.byItem(vars.itemId) });
    },
  });
}

export function useUnlinkAccessory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, accessoryId }: { itemId: number; accessoryId: number }) =>
      api.del(`/api/accessories/_d_/item/${itemId}/unlink/${accessoryId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.accessories.byItem(vars.itemId) });
    },
  });
}
