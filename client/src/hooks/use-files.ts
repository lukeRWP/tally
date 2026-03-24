import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';
import type { ItemFile, ConditionSnapshot } from '@/types/files';

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function useItemFiles(itemId: number) {
  return useQuery({
    queryKey: queryKeys.files.byItem(itemId),
    queryFn: () => api.get<ItemFile[]>(`/api/files/_x_/item/${itemId}`),
    enabled: !!itemId,
  });
}

export function useUploadFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      itemId,
      file,
      fileType,
    }: {
      itemId: number;
      file: File;
      fileType: string;
    }) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileType', fileType);
      const res = await fetch(`/api/files/_y_/item/${itemId}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Upload failed');
      }
      return json.data as ItemFile;
    },
    onSuccess: (_: unknown, vars: { itemId: number; file: File; fileType: string }) => {
      qc.invalidateQueries({ queryKey: queryKeys.files.byItem(vars.itemId) });
    },
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId }: { fileId: number; itemId: number }) =>
      api.del(`/api/files/_d_/${fileId}`),
    onSuccess: (_: unknown, vars: { fileId: number; itemId: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.files.byItem(vars.itemId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Condition snapshots
// ---------------------------------------------------------------------------

export function useConditionHistory(itemId: number) {
  return useQuery({
    queryKey: queryKeys.conditions.byItem(itemId),
    queryFn: () => api.get<ConditionSnapshot[]>(`/api/conditions/_x_/item/${itemId}`),
    enabled: !!itemId,
  });
}

export function useCreateCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      itemId,
      condition,
      notes,
      photo,
    }: {
      itemId: number;
      condition: string;
      notes?: string;
      photo?: File;
    }) => {
      const formData = new FormData();
      formData.append('condition', condition);
      if (notes) formData.append('notes', notes);
      if (photo) formData.append('photo', photo);
      const res = await fetch(`/api/conditions/_y_/item/${itemId}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Failed to record condition');
      }
      return json.data as ConditionSnapshot;
    },
    onSuccess: (_: unknown, vars: { itemId: number; condition: string; notes?: string; photo?: File }) => {
      qc.invalidateQueries({ queryKey: queryKeys.conditions.byItem(vars.itemId) });
    },
  });
}
