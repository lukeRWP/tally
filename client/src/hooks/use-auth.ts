import { useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';

export function useAuth() {
  const store = useAuthStore();

  useEffect(() => {
    store.checkSession();
  }, []);

  return store;
}
