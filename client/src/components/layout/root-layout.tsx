import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { Header } from './header';
import { BottomNav } from './bottom-nav';

export function RootLayout() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex items-center justify-center h-screen">
      <div className="text-[var(--color-text-muted)]">Loading...</div>
    </div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--color-bg)]">
      <Header />
      <main className="flex-1 overflow-y-auto pb-20 px-4 pt-4">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
