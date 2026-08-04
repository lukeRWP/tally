import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LabelPreset } from '@/hooks/use-labels';

export type PrintablePreset = Exclude<LabelPreset, 'sheet'>;

export interface Printer {
  id: number;
  propertyId: number;
  name: string;
  loadedMedia: PrintablePreset;
  printerState: 'idle' | 'printing' | 'stopped' | 'unknown';
  printerStateReasons: string[];
  lastSeenAt: string | null;
}

export interface PrintJob {
  id: number;
  entityType: string;
  entityIds: number[];
  preset: PrintablePreset;
  status: 'queued' | 'held' | 'claimed' | 'done' | 'failed' | 'canceled';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const printerKeys = {
  printers: (propertyId: number) => ['print', 'printers', propertyId] as const,
  jobs: (propertyId: number) => ['print', 'jobs', propertyId] as const,
};

export function usePrinters(propertyId?: number) {
  return useQuery({
    queryKey: printerKeys.printers(propertyId ?? 0),
    queryFn: () => api.get<Printer[]>(`/api/print/_x_/agents?propertyId=${propertyId}`),
    enabled: !!propertyId,
    // The agent refreshes LAST_SEEN_AT every 2s; poll often enough that the
    // online indicator and printer status stay believable while the dialog is open.
    refetchInterval: 15000,
  });
}

export function usePrintJobs(propertyId?: number) {
  return useQuery({
    queryKey: printerKeys.jobs(propertyId ?? 0),
    queryFn: () => api.get<PrintJob[]>(`/api/print/_x_/jobs?propertyId=${propertyId}`),
    enabled: !!propertyId,
    refetchInterval: 15000,
  });
}

export function useCreatePrintJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { entityType: string; entityIds: number[]; preset: PrintablePreset; propertyId?: number }) =>
      api.post<{ id: number; status: PrintJob['status'] }>('/api/print/_y_/jobs', {
        entityType: vars.entityType, entityIds: vars.entityIds, preset: vars.preset,
      }),
    onSuccess: (_d, vars) => {
      if (vars.propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(vars.propertyId) });
    },
  });
}

export function useCancelPrintJob(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.patch(`/api/print/_p_/jobs/${jobId}/cancel`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) }); },
  });
}

export function useRetryPrintJob(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.post(`/api/print/_y_/jobs/${jobId}/retry`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) }); },
  });
}

export function useCreatePrinter(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ id: number; name: string; token: string }>('/api/print/_y_/agents', { propertyId, name }),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) }); },
  });
}

export function useRevokePrinter(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/print/_d_/agents/${id}`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) }); },
  });
}

export function useSetLoadedMedia(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; loadedMedia: PrintablePreset }) =>
      api.put<{ released: number }>(`/api/print/_u_/agents/${vars.id}/loaded-media`, { loadedMedia: vars.loadedMedia }),
    onSuccess: () => {
      if (propertyId) {
        qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) });
        qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) });
      }
    },
  });
}
