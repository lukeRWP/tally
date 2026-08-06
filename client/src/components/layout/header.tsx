import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NotificationBell } from '@/components/notifications/notification-bell';

export function Header() {
  const navigate = useNavigate();
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-[var(--color-bg)] border-b-2 border-[var(--color-text)]">
      <div className="flex items-center gap-2">
        {/* Solid ink chip mark + mono wordmark — the printed-label brand, on
            every screen, so the whole app reads thermal from the frame in. */}
        <span className="w-4 h-4 rounded-[2px] bg-[var(--color-primary)] shrink-0" aria-hidden="true" />
        <h1 className="font-mono text-sm font-extrabold uppercase tracking-[0.22em] text-[var(--color-text)]">Tally</h1>
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
