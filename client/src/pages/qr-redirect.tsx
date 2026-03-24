import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Loader2, ScanLine } from 'lucide-react';

type ResolveResult = {
  type: 'property' | 'area' | 'container' | 'item';
  id: number;
};

type Status = 'loading' | 'not_found' | 'error';

export function QrRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!code) {
      setStatus('not_found');
      return;
    }

    let cancelled = false;

    async function resolve() {
      const res = await fetch(`/api/labels/_x_/resolve/${code}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      if (cancelled) return;

      if (res.status === 401) {
        navigate(`/login?redirect=/s/${code}`, { replace: true });
        return;
      }

      if (!res.ok) {
        setStatus('not_found');
        return;
      }

      const json = await res.json();
      if (!json.success || !json.data) {
        setStatus('not_found');
        return;
      }

      const entity: ResolveResult = json.data;

      const paths: Record<ResolveResult['type'], string> = {
        property: `/property/${entity.id}`,
        area: `/area/${entity.id}`,
        container: `/container/${entity.id}`,
        item: `/item/${entity.id}`,
      };

      const destination = paths[entity.type];
      if (!destination) {
        setStatus('not_found');
        return;
      }

      navigate(destination, { replace: true });
    }

    resolve().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
    };
  }, [code, navigate]);

  if (status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 bg-[var(--color-bg)]">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--color-primary)]" />
        <p className="text-[var(--color-text-secondary)] text-sm">Resolving code…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-6 bg-[var(--color-bg)] px-6">
      <ScanLine className="w-12 h-12 text-[var(--color-text-muted)]" />
      <div className="text-center space-y-2">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Entity not found</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {status === 'error'
            ? 'Something went wrong while resolving this code.'
            : 'This QR code does not match any item in your inventory.'}
        </p>
      </div>
      <Link
        to="/"
        className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-opacity"
      >
        Go to home
      </Link>
    </div>
  );
}
