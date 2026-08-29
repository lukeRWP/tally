import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { Loader2, ScanLine } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

type EntityType = 'property' | 'area' | 'container' | 'item';

/**
 * The shape labels.service.js resolveCode() actually returns. This endpoint
 * always answers 200 (see labels.routes.js) — an unknown code, a malformed
 * one, or one belonging to someone else's property all come back the same
 * way: `exists: false`. It never 404s, so "code doesn't exist" has to be
 * read off this flag, not off the HTTP status.
 */
type ResolveResult = {
  type: EntityType | null;
  id: number | null;
  name: string | null;
  exists: boolean;
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
      let entity: ResolveResult;
      try {
        entity = await api.get<ResolveResult>(`/api/labels/_x_/resolve/${encodeURIComponent(code as string)}`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate(`/login?redirect=/s/${code}`, { replace: true });
          return;
        }
        // A real failure (bad code format = 400, a 5xx, a network drop) —
        // we couldn't actually check, which is a different story from the
        // server confirming the code doesn't exist.
        setStatus('error');
        return;
      }

      if (cancelled) return;

      if (!entity.exists || !entity.type || entity.id == null) {
        setStatus('not_found');
        return;
      }

      const paths: Record<EntityType, string> = {
        property: `/property/${entity.id}`,
        area: `/area/${entity.id}`,
        container: `/container/${entity.id}`,
        item: `/item/${entity.id}`,
      };

      navigate(paths[entity.type], { replace: true });
    }

    resolve();

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

  const isError = status === 'error';

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-6 bg-[var(--color-bg)] px-6">
      <ScanLine className="w-12 h-12 text-[var(--color-text-muted)]" />
      <div className="text-center space-y-2">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">
          {isError ? "Couldn't check that code" : 'Entity not found'}
        </h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {isError
            ? "Something went wrong while checking this code — try again."
            : 'This QR code does not match any item in your inventory.'}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Link
          to="/scan"
          className="px-5 py-2.5 border border-[var(--color-text)] text-[var(--color-text)] rounded-[var(--radius-md)] text-sm font-medium hover:bg-[var(--color-text)] hover:text-[var(--color-bg)] transition-colors"
        >
          Scan again
        </Link>
        <Link
          to="/"
          className="px-5 py-2.5 bg-[var(--color-primary)] text-white rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Go to home
        </Link>
      </div>
    </div>
  );
}
