import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NotificationBell } from '@/components/notifications/notification-bell';

export function Header() {
  const navigate = useNavigate();
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-[var(--color-card)] border-b border-[var(--color-border)]/50">
      <div className="flex items-center gap-2">
        <svg
          viewBox="0 0 100 100"
          className="w-6 h-6 text-[var(--color-primary)]"
          fill="none"
          stroke="currentColor"
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="24" y="32" width="52" height="42" rx="5" />
          <line x1="24" y1="45" x2="76" y2="45" />
          <line x1="50" y1="32" x2="50" y2="45" />
        </svg>
        <h1 className="text-xl font-extrabold tracking-tighter text-[var(--color-text)]">Tally</h1>
      </div>
      <div className="flex items-center">
        {/* Search reachable in one tap from EVERY screen — "Where is X?" is
            the app's #1 job and used to require navigating to Home first. */}
        <button
          type="button"
          aria-label="Search"
          className="p-2"
          onClick={() => navigate('/search')}
        >
          <Search className="w-5 h-5 text-[var(--color-text-secondary)]" />
        </button>
        <NotificationBell />
      </div>
    </header>
  );
}
