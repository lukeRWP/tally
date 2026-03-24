import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: number | null;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications(options?: { unreadOnly?: boolean }) {
  return useQuery({
    queryKey: [...queryKeys.notifications.list(), options],
    queryFn: () =>
      api.get<Notification[]>(
        `/api/notifications/_x_/list?unreadOnly=${options?.unreadOnly || false}`,
      ),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: () => api.get<number>('/api/notifications/_x_/unread-count'),
    refetchInterval: 60000, // Poll every minute
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.patch(`/api/notifications/_p_/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.patch('/api/notifications/_p_/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  });
}

export function useDismissNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/notifications/_d_/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: queryKeys.notifications.preferences(),
    queryFn: () => api.get<Record<string, boolean>>('/api/notifications/_x_/preferences'),
  });
}

export function useUpdatePreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; enabled: boolean }) =>
      api.put('/api/notifications/_u_/preferences', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.notifications.preferences() }),
  });
}

export interface AuditEntry {
  id: number;
  displayName: string;
  entityType: string;
  entityId: number;
  action: string;
  changes: Record<string, unknown>;
  createdAt: string;
}

export function useRecentActivity() {
  return useQuery({
    queryKey: queryKeys.audit.recent(),
    queryFn: () => api.get<AuditEntry[]>('/api/audit/_x_/recent'),
  });
}
