import { useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';

export function useAuth() {
  const store = useAuthStore();
  // Zustand actions are stable references, so this really is a mount-only
  // effect; depending on `store` itself would re-check on every auth change.
  const { checkSession } = store;

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return store;
}
