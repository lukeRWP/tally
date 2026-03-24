import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { Package, Box, Building2, MapPin, AlertTriangle, Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShareViewData {
  entityType: 'property' | 'container' | 'item';
  entity: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ''): string {
  return v != null ? String(v) : fallback;
}

function conditionLabel(c: string) {
  const map: Record<string, string> = { new: 'New', good: 'Good', fair: 'Fair', poor: 'Poor' };
  return map[c] ?? c;
}

function conditionColor(c: string) {
  const map: Record<string, string> = {
    new: 'var(--color-green)',
    good: 'var(--color-primary)',
    fair: 'var(--color-amber)',
    poor: 'var(--color-red)',
  };
  return map[c] ?? 'var(--color-text-muted)';
}

// ---------------------------------------------------------------------------
// Entity renderers
// ---------------------------------------------------------------------------

function PropertyView({ entity }: { entity: Record<string, unknown> }) {
  const areas = (entity.areas as Record<string, unknown>[] | undefined) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>
          {str(entity.name)}
        </h2>
        {!!entity.address && (
          <p className="text-sm mt-0.5 flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
            <MapPin className="w-3.5 h-3.5" />
            {str(entity.address)}
          </p>
        )}
        {!!entity.description && (
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            {str(entity.description)}
          </p>
        )}
      </div>

      {areas.map((area) => {
        const containers = (area.containers as Record<string, unknown>[] | undefined) ?? [];
        return (
          <div
            key={str(area.id)}
            className="rounded-lg border p-4"
            style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Building2 className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {str(area.name)}
              </h3>
            </div>
            {containers.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No containers.</p>
            )}
            <div className="flex flex-col gap-2">
              {containers.map((c) => (
                <ContainerRow key={str(c.id)} container={c} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ContainerRow({ container }: { container: Record<string, unknown> }) {
  const items = (container.items as Record<string, unknown>[] | undefined) ?? [];
  const children = (container.children as Record<string, unknown>[] | undefined) ?? [];

  return (
    <div
      className="rounded-md border p-3"
      style={{ background: 'var(--color-elevated)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Package className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          {str(container.name)}
        </span>
        {!!container.type && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono"
            style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}
          >
            {str(container.type)}
          </span>
        )}
      </div>
      {items.length > 0 && (
        <div className="ml-5 flex flex-col gap-1 mt-1">
          {items.map((item) => (
            <ItemRow key={str(item.id)} item={item} compact />
          ))}
        </div>
      )}
      {children.length > 0 && (
        <div className="ml-3 flex flex-col gap-1 mt-2">
          {children.map((child) => (
            <ContainerRow key={str(child.id)} container={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function ContainerView({ entity }: { entity: Record<string, unknown> }) {
  const breadcrumb = (entity.breadcrumb as { id: number; name: string; type: string }[] | undefined) ?? [];
  const items = (entity.items as Record<string, unknown>[] | undefined) ?? [];
  const children = (entity.children as Record<string, unknown>[] | undefined) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      {breadcrumb.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {breadcrumb.map((b, i) => (
            <React.Fragment key={b.id}>
              {i > 0 && <span>/</span>}
              <span>{b.name}</span>
            </React.Fragment>
          ))}
        </nav>
      )}

      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>
            {str(entity.name)}
          </h2>
          {!!entity.type && (
            <span
              className="text-xs px-2 py-0.5 rounded font-mono"
              style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}
            >
              {str(entity.type)}
            </span>
          )}
        </div>
        {!!entity.description && (
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            {str(entity.description)}
          </p>
        )}
      </div>

      {/* Nested containers */}
      {children.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            Nested Containers
          </h3>
          <div className="flex flex-col gap-2">
            {children.map((c) => (
              <ContainerRow key={str(c.id)} container={c} />
            ))}
          </div>
        </div>
      )}

      {/* Items */}
      {items.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            Items ({items.length})
          </h3>
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <ItemRow key={str(item.id)} item={item} />
            ))}
          </div>
        </div>
      )}

      {children.length === 0 && items.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>This container is empty.</p>
      )}
    </div>
  );
}

function ItemRow({ item, compact = false }: { item: Record<string, unknown>; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <Box className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--color-text)' }}>{str(item.name)}</span>
        {!!item.condition && (
          <span className="text-[10px] font-medium" style={{ color: conditionColor(str(item.condition)) }}>
            {conditionLabel(str(item.condition))}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border p-3"
      style={{ background: 'var(--color-elevated)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start gap-2">
        <Box className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {str(item.name)}
          </p>
          {!!item.description && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {str(item.description)}
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-1">
            {!!item.condition && (
              <span className="text-[10px] font-medium" style={{ color: conditionColor(str(item.condition)) }}>
                {conditionLabel(str(item.condition))}
              </span>
            )}
            {item.quantity != null && Number(item.quantity) > 1 && (
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                Qty: {str(item.quantity)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemView({ entity }: { entity: Record<string, unknown> }) {
  const breadcrumb = (entity.breadcrumb as { id: number; name: string; type: string }[] | undefined) ?? [];
  const product = entity.product as Record<string, unknown> | null | undefined;
  const files = (entity.files as Record<string, unknown>[] | undefined) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      {breadcrumb.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {breadcrumb.map((b, i) => (
            <React.Fragment key={b.id}>
              {i > 0 && <span>/</span>}
              <span>{b.name}</span>
            </React.Fragment>
          ))}
        </nav>
      )}

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>
          {str(entity.name)}
        </h2>
        <div className="flex items-center gap-2 mt-1">
          {!!entity.condition && (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded"
              style={{
                background: 'var(--color-elevated)',
                color: conditionColor(str(entity.condition)),
                border: '1px solid var(--color-border)',
              }}
            >
              {conditionLabel(str(entity.condition))}
            </span>
          )}
          {!!entity.status && (
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
            >
              {str(entity.status)}
            </span>
          )}
          {entity.quantity != null && Number(entity.quantity) > 1 && (
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
            >
              Qty: {str(entity.quantity)}
            </span>
          )}
        </div>
        {!!entity.description && (
          <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
            {str(entity.description)}
          </p>
        )}
      </div>

      {/* Product info */}
      {!!product && (
        <div
          className="rounded-lg border p-4"
          style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        >
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text)' }}>Product Info</h3>
          {!!product.imageUrl && (
            <img
              src={str(product.imageUrl)}
              alt={str(product.name)}
              className="w-full h-32 object-contain rounded mb-2"
              style={{ background: 'var(--color-elevated)' }}
            />
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {!!product.brand && (
              <div>
                <span style={{ color: 'var(--color-text-muted)' }}>Brand</span>
                <p className="font-medium" style={{ color: 'var(--color-text)' }}>{str(product.brand)}</p>
              </div>
            )}
            {!!product.category && (
              <div>
                <span style={{ color: 'var(--color-text-muted)' }}>Category</span>
                <p className="font-medium" style={{ color: 'var(--color-text)' }}>{str(product.category)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Value */}
      {(entity.purchasePrice != null || entity.currentValue != null) && (
        <div
          className="rounded-lg border p-4"
          style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        >
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text)' }}>Value</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Purchase Price</span>
              <p className="font-medium" style={{ color: 'var(--color-text)' }}>
                {entity.purchasePrice != null ? `$${Number(entity.purchasePrice).toFixed(2)}` : '--'}
              </p>
            </div>
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Current Value</span>
              <p className="font-medium" style={{ color: 'var(--color-text)' }}>
                {entity.currentValue != null ? `$${Number(entity.currentValue).toFixed(2)}` : '--'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Photos & files */}
      {files.length > 0 && (
        <div
          className="rounded-lg border p-4"
          style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        >
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            Files ({files.length})
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {files.map((f) => {
              const isImage = str(f.mimeType).startsWith('image/');
              return isImage ? (
                <img
                  key={str(f.id)}
                  src={str(f.url ?? f.presignedUrl)}
                  alt={str(f.originalName)}
                  className="w-full aspect-square object-cover rounded"
                  style={{ border: '1px solid var(--color-border)' }}
                />
              ) : (
                <div
                  key={str(f.id)}
                  className="flex items-center justify-center aspect-square rounded text-xs font-medium"
                  style={{
                    background: 'var(--color-elevated)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {str(f.originalName, 'File')}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = React.useState<ShareViewData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) {
      setError('Invalid share link.');
      setLoading(false);
      return;
    }

    fetch(`/api/sharing/_x_/view/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error((json as { message?: string }).message || 'This link has expired or is invalid.');
        }
        const json = await res.json();
        setData((json.data ?? json) as ShareViewData);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'This link has expired or is invalid.');
      })
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div
      className="min-h-screen"
      style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
    >
      {/* Header */}
      <div
        className="sticky top-0 z-10 border-b px-4 py-3"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <div>
            <p className="text-base font-bold" style={{ color: 'var(--color-text)' }}>Tally</p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Shared view — read only</p>
          </div>
          <Link
            to="/"
            className="text-xs px-3 py-1.5 rounded-md transition-colors"
            style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}
          >
            Sign in
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-xl mx-auto px-4 py-6">
        {loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--color-primary)' }} />
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading shared content…</p>
          </div>
        )}

        {!loading && !!error && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ background: 'var(--color-red-bg)' }}
            >
              <AlertTriangle className="w-8 h-8" style={{ color: 'var(--color-red)' }} />
            </div>
            <h1 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
              Link unavailable
            </h1>
            <p className="text-sm max-w-xs" style={{ color: 'var(--color-text-muted)' }}>
              {error}
            </p>
            <Link
              to="/"
              className="text-sm font-medium mt-2"
              style={{ color: 'var(--color-primary)' }}
            >
              Go to Tally
            </Link>
          </div>
        )}

        {!loading && !error && !!data && (
          <>
            {data.entityType === 'property' && <PropertyView entity={data.entity} />}
            {data.entityType === 'container' && <ContainerView entity={data.entity} />}
            {data.entityType === 'item' && <ItemView entity={data.entity} />}
          </>
        )}
      </div>
    </div>
  );
}
