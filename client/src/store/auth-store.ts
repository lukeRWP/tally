import { create } from 'zustand';
import { api } from '@/lib/api';
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
      const data = await api.get<{ user: User }>('/api/auth/_x_/session');
      set({ user: data.user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  logout: async () => {
    try {
      await api.post('/api/auth/_y_/logout');
    } finally {
      set({ user: null });
    }
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
