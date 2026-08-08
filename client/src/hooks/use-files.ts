import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCsrfToken, parseEnvelope } from '@/lib/api';
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
      // Raw fetch (FormData upload) — attach CSRF manually; do NOT set
      // Content-Type so the browser sets the multipart boundary.
      const csrf = getCsrfToken();
      const res = await fetch(`/api/files/_y_/item/${itemId}/upload`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: formData,
      });
      return parseEnvelope<ItemFile>(res);
    },
    onSuccess: (_: unknown, vars: { itemId: number; file: File; fileType: string }) => {
      qc.invalidateQueries({ queryKey: queryKeys.files.byItem(vars.itemId) });
      // Item rows carry their newest photo, and the capture flow uploads it
      // only AFTER the item exists — so without this the thing you just
      // photographed sits in every list with an empty frame until the cache
      // goes stale on its own.
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
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
      // Deleting the newest photo changes which one an item row shows.
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
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
      // Raw fetch (FormData) — attach CSRF manually; no Content-Type so the
      // browser sets the multipart boundary.
      const csrf = getCsrfToken();
      const res = await fetch(`/api/conditions/_y_/item/${itemId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: formData,
      });
      return parseEnvelope<ConditionSnapshot>(res);
    },
    onSuccess: (_: unknown, vars: { itemId: number; condition: string; notes?: string; photo?: File }) => {
      qc.invalidateQueries({ queryKey: queryKeys.conditions.byItem(vars.itemId) });
      // A snapshot also updates the item's CONDITION, so refresh the item detail
      // + lists (was left stale on the same page).
      qc.invalidateQueries({ queryKey: queryKeys.items.detail(vars.itemId) });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
    },
  });
}
