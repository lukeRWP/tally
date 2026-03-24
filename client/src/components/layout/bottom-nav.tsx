import { useLocation, useNavigate } from 'react-router-dom';
import { Home, Layers, ScanLine, BarChart2, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/inventory', icon: Layers, label: 'Inventory' },
  { path: '/scan', icon: ScanLine, label: 'Scan', center: true },
  { path: '/reports', icon: BarChart2, label: 'Reports' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-[var(--color-card)]/90 border-t border-[var(--color-border)]/50 z-50">
      <div className="flex items-center justify-around py-2 md:py-3 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = location.pathname === tab.path;
          const Icon = tab.icon;

          if (tab.center) {
            return (
              <button key={tab.path} onClick={() => navigate(tab.path)}
                className="flex flex-col items-center -mt-5 transition-transform duration-200 active:scale-95">
                <div className={cn(
                  'w-13 h-13 rounded-full bg-[var(--color-primary)] flex items-center justify-center shadow-lg',
                  !isActive && 'animate-pulse-ring',
                )}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <span className="text-[10px] mt-1 font-medium text-[var(--color-text-muted)]">{tab.label}</span>
              </button>
            );
          }

          return (
            <button key={tab.path} onClick={() => navigate(tab.path)}
              className="flex flex-col items-center gap-0.5 py-1 relative transition-colors duration-200">
              {isActive && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--color-primary)]" />
              )}
              <Icon className={cn(
                'w-5 h-5 transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
              )} />
              <span className={cn(
                'text-[10px] transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)] font-semibold' : 'text-[var(--color-text-muted)]',
              )}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
