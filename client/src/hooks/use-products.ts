import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

interface LookupResult {
  source: 'local' | 'upc_db' | 'open_food_facts' | 'not_found';
  product: Record<string, unknown>;
}

interface DuplicateItem {
  id: number;
  name: string;
  containerName: string;
  areaName: string;
  propertyName: string;
}

export function useLookupBarcode() {
  return useMutation({
    mutationFn: (barcode: string) =>
      api.post<LookupResult>('/api/products/_y_/lookup', { barcode }),
  });
}

export function useCheckDuplicate() {
  return useMutation({
    mutationFn: (barcode: string) =>
      api.post<DuplicateItem[]>('/api/products/_y_/check-duplicate', { barcode }),
  });
}

export function useSearchProducts(query: string) {
  return useQuery({
    queryKey: queryKeys.products.search(query),
    queryFn: () => api.get<{ products: unknown[] }>(`/api/products/_x_/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
    select: (data) => data.products,
  });
}

export function useCreateProduct() {
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post('/api/products/_y_/create', data),
  });
}
