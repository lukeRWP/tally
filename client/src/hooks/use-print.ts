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
    // online indicator and printer status stay believable while this hook is
    // mounted with an active propertyId. Callers that render conditionally
    // (e.g. a dialog) must pass `undefined` when hidden so polling stops —
    // passing `propertyId` unconditionally polls for as long as the
    // component stays mounted, dialog closed or not.
    refetchInterval: 15000,
    // Notify on every settled fetch, not only when the data changes shape.
    // Online-ness is derived from `Date.now() - lastSeenAt`, so it goes stale
    // with the clock, not with the payload. The moment a printer dies is
    // exactly the moment its row stops changing — structural sharing would
    // hand back an identical reference, no re-render would happen, and the
    // badge would stay on "Online" precisely when it needs to say "Offline".
    notifyOnChangeProps: 'all',
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

/**
 * An agent stamps LAST_SEEN_AT on every claim and polls every 2s, so a minute
 * of silence is the same "offline" threshold `/print`'s own badge uses.
 */
const AGENT_STALE_MS = 60_000;

/**
 * How many print jobs are waiting on a human.
 *
 * Carrying gets a docked banner and alerts get a count, but printing — the one
 * queue-it-and-walk-away flow in the app — surfaced nothing outside `/print`
 * itself, so "nothing has printed for two days" was discovered by chance
 * (#283). Failed and held jobs always count; queued work counts only when
 * there is nothing alive to print it, because an idle printer that is switched
 * off is not a problem until something is waiting for it.
 */
export function printAttentionCount(
  jobs: PrintJob[] | undefined,
  printers: Printer[] | undefined,
  now = Date.now(),
): number {
  const queue = jobs ?? [];
  const failed = queue.filter((j) => j.status === 'failed').length;
  const held = queue.filter((j) => j.status === 'held').length;
  const waiting = queue.filter((j) => j.status === 'queued' || j.status === 'claimed').length;

  const live = (printers ?? []).some(
    (p) =>
      p.printerState !== 'stopped' &&
      !!p.lastSeenAt &&
      now - new Date(p.lastSeenAt).getTime() < AGENT_STALE_MS,
  );

  return failed + held + (live ? 0 : waiting);
}

export function usePrintAttention(propertyId?: number) {
  const { data: jobs } = usePrintJobs(propertyId);
  const { data: printers } = usePrinters(propertyId);
  return printAttentionCount(jobs, printers);
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
