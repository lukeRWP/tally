import { Bell } from 'lucide-react';

export function Header() {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-[var(--color-card)] border-b border-[var(--color-border)]">
      <h1 className="text-lg font-bold tracking-tight">Tally</h1>
      <button className="relative p-2">
        <Bell className="w-5 h-5 text-[var(--color-text-secondary)]" />
      </button>
    </header>
  );
}
