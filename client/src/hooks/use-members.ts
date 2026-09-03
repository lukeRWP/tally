import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';
import type { PropertyMember } from '@/types/inventory';

export type MemberRole = PropertyMember['role'];

/**
 * Property membership (#345). Every route here is owner-only on the server,
 * so the list query is `enabled` by the caller's role — a viewer never even
 * asks and never sees a 403 in the network tab.
 */
export function usePropertyMembers(propertyId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.properties.members(propertyId),
    queryFn: () =>
      api.get<{ members: PropertyMember[] }>(`/api/properties/_x_/${propertyId}/members`),
    select: (data) => data.members,
    enabled: enabled && propertyId > 0,
  });
}

/**
 * The properties list carries the CALLER's role, so a change to their own
 * row (demoted, or promoted a second owner and then demoted themselves) has
 * to refetch that too — otherwise the Members section keeps rendering for
 * someone who can no longer use it.
 */
function useInvalidateMembership(propertyId: number) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.properties.members(propertyId) });
    qc.invalidateQueries({ queryKey: queryKeys.properties.list() });
  };
}

export function useAddMember(propertyId: number) {
  const invalidate = useInvalidateMembership(propertyId);
  return useMutation({
    mutationFn: (data: { email: string; role: Exclude<MemberRole, 'owner'> }) =>
      api.post<{ member: PropertyMember }>(`/api/properties/_y_/${propertyId}/members`, data),
    onSuccess: invalidate,
  });
}

export function useUpdateMemberRole(propertyId: number) {
  const invalidate = useInvalidateMembership(propertyId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: MemberRole }) =>
      api.patch<{ member: PropertyMember }>(`/api/properties/_p_/${propertyId}/members/${userId}`, { role }),
    onSuccess: invalidate,
  });
}

export function useRemoveMember(propertyId: number) {
  const invalidate = useInvalidateMembership(propertyId);
  return useMutation({
    mutationFn: (userId: number) =>
      api.del<null>(`/api/properties/_d_/${propertyId}/members/${userId}`),
    onSuccess: invalidate,
  });
}
