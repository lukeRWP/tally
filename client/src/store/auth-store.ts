import { create } from 'zustand';
import { getCsrfToken } from '@/lib/api';
import type { User } from '@/types/auth';

type Theme = 'light' | 'dark' | 'system';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  theme: Theme;
  setUser: (user: User | null) => void;
  setTheme: (theme: Theme) => void;
  checkSession: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * The two session endpoints are @pw/auth-express's (server auth.routes.js),
 * not docket routes: `GET /api/auth/session` answers `{ user, auth }` and
 * `POST /api/auth/logout` answers `{ redirect }` — neither is the
 * `{ success, data }` envelope `api.get` unwraps, hence the raw fetches.
 */
const SESSION_URL = '/api/auth/session';
const LOGOUT_URL = '/api/auth/logout';

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  theme: (localStorage.getItem('tally-theme') as Theme) || 'system',

  setUser: (user) => set({ user }),

  setTheme: (theme) => {
    localStorage.setItem('tally-theme', theme);
    applyTheme(theme);
    set({ theme });
  },

  checkSession: async () => {
    try {
      const res = await fetch(SESSION_URL, { credentials: 'include' });
      if (!res.ok) throw new Error(`session ${res.status}`);
      const data = (await res.json()) as { user: User };
      set({ user: data.user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  /**
   * Ends the app session, then follows the shim to pwiam's end-session page
   * so the SSO session ends too (spec §6: app logout = destroy app session +
   * RP-initiated end-session). Callers do not navigate afterwards — this
   * does, and a caller's own `assign('/login')` would race it.
   */
  logout: async () => {
    let redirect = '/login';
    try {
      const csrf = getCsrfToken();
      const res = await fetch(LOGOUT_URL, {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      });
      if (res.ok) {
        const data = (await res.json()) as { redirect?: string };
        if (typeof data.redirect === 'string' && data.redirect) redirect = data.redirect;
      }
    } catch {
      /* the cookie may be gone already; the login page is the safe landing */
    } finally {
      set({ user: null });
    }
    window.location.assign(redirect);
  },
}));

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') {
    root.classList.add(theme);
  }
  // Keep the browser status-bar / address-bar color in sync with the resolved theme.
  const effective =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'dark' ? '#1c1c1c' : '#f7f7f5');
}

// Apply theme on load
applyTheme(useAuthStore.getState().theme);
