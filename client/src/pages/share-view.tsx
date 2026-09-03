import * as React from 'react';
import { Link, useParams } from 'react-router';
import { Package, Box, Building2, MapPin, AlertTriangle, Loader2, FileText } from 'lucide-react';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { RuledRow } from '@/components/ui/ruled-row';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/**
 * What the server actually sends (sharing.service.js): a discriminated envelope
 * whose payload is NESTED and FLAT-listed —
 *   property  { type, property, areas[], containers[], items[] }
 *   area      { type, area,     containers[], items[] }
 *   container { type, container, nestedContainers[], items[] }
 *   item      { type, item, files[], dates[], conditionSnapshots[] }
 *
 * The renderers below want the opposite: one flat entity with its children
 * already nested (entity.areas[].containers[].items[]). This page used to read
 * `data.entityType` — a key the server has never sent — so every branch was
 * false and EVERY share link rendered a blank page. Normalising here keeps the
 * renderers untouched and makes the shape mismatch explicit in one place.
 */
interface ShareEnvelope extends Rec {
  type: 'property' | 'area' | 'container' | 'item';
}

/**
 * The framing the public route sends alongside the entity (`data.share`): who
 * shared it and when the link dies. Every field is optional on purpose — an
 * older server, or a link whose creator row is gone, sends less, and the page
 * must then say less rather than invent a name or a date.
 */
interface ShareMeta {
  sharedByName?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
}

const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

/** Nest containers by parentContainerId and hang items off their container. */
function stitchContainers(containers: Rec[], items: Rec[], areaId?: unknown): Rec[] {
  const scoped = areaId == null ? containers : containers.filter((c) => c.areaId === areaId);
  const byId = new Map<unknown, Rec>();
  for (const c of scoped) byId.set(c.id, { ...c, children: [], items: [] });
  for (const it of items) {
    const parent = byId.get(it.containerId);
    if (parent) (parent.items as Rec[]).push(it);
  }
  const roots: Rec[] = [];
  for (const c of byId.values()) {
    const parent = c.parentContainerId != null ? byId.get(c.parentContainerId) : undefined;
    if (parent) (parent.children as Rec[]).push(c);
    else roots.push(c);
  }
  return roots;
}

/** The item payload carries product fields flat; ItemView wants them grouped. */
function productOf(item: Rec): Rec | null {
  if (!item.productName && !item.productBrand && !item.productImageUrl) return null;
  return {
    name: item.productName,
    brand: item.productBrand,
    imageUrl: item.productImageUrl,
    description: item.productDescription,
    category: (item as { productCategory?: unknown }).productCategory,
  };
}

function normalize(p: ShareEnvelope): { kind: ShareEnvelope['type']; entity: Rec } | null {
  switch (p.type) {
    case 'property':
      return {
        kind: 'property',
        entity: {
          ...(p.property as Rec),
          areas: arr(p.areas).map((a) => ({
            ...a,
            containers: stitchContainers(arr(p.containers), arr(p.items), a.id),
          })),
        },
      };
    case 'area':
      return {
        kind: 'area',
        entity: { ...(p.area as Rec), containers: stitchContainers(arr(p.containers), arr(p.items)) },
      };
    case 'container':
      return {
        kind: 'container',
        entity: { ...(p.container as Rec), children: arr(p.nestedContainers), items: arr(p.items) },
      };
    case 'item': {
      const item = (p.item as Rec) ?? {};
      return {
        kind: 'item',
        entity: {
          ...item,
          product: productOf(item),
          files: arr(p.files),
          dates: arr(p.dates),
          conditionSnapshots: arr(p.conditionSnapshots),
        },
      };
    }
    default:
      return null;
  }
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

/** Condition on the thermal badge scale: new is the only "better than fine". */
function conditionVariant(c: string): 'default' | 'success' | 'warning' | 'danger' {
  const map: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
    new: 'success',
    good: 'default',
    fair: 'warning',
    poor: 'danger',
  };
  return map[c] ?? 'default';
}

/** A date the sharer would recognise, or null if the payload has no usable one. */
function formatDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Null when there is no figure, so `Facts` drops the row entirely. The old page
 * printed "Current Value --" on every item share: `sharing.service.js` has
 * never mapped `currentValue` into the public payload, so that cell could only
 * ever be empty. Absent data says nothing rather than showing a blank label.
 */
function money(v: unknown): string | null {
  return v != null ? `$${Number(v).toFixed(2)}` : null;
}

/**
 * What a stranger is actually looking at. A property share IS the whole home,
 * so it must not claim otherwise; the other three are one slice of one.
 */
const SCOPE: Record<ShareEnvelope['type'], string> = {
  item: 'one item from someone’s home inventory',
  container: 'the contents of one container from someone’s home inventory',
  area: 'the contents of one room from someone’s home inventory',
  property: 'one whole property from someone’s home inventory',
};

/** The mono meta line under a ruled row: TYPE · CODE · location, dots between. */
function meta(...parts: (string | null | undefined | false)[]) {
  const kept = parts.filter(Boolean) as string[];
  return kept.length ? kept.join(' · ') : undefined;
}

// ---------------------------------------------------------------------------
// Entity renderers
// ---------------------------------------------------------------------------

function Breadcrumb({ trail }: { trail: { id: number; name: string; type: string }[] }) {
  if (!trail.length) return null;
  return (
    <nav className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      {trail.map((b, i) => (
        <React.Fragment key={`${b.type}-${b.id}`}>
          {i > 0 && <span aria-hidden="true">/</span>}
          <span>{b.name}</span>
        </React.Fragment>
      ))}
    </nav>
  );
}

function EntityHead({
  name,
  icon,
  badges,
  sub,
  description,
  trail,
}: {
  name: string;
  icon?: React.ReactNode;
  badges?: React.ReactNode;
  sub?: React.ReactNode;
  description?: string;
  trail?: { id: number; name: string; type: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      {trail != null && <Breadcrumb trail={trail} />}
      <div className="flex flex-wrap items-center gap-2">
        {icon}
        <TitleBar>{name}</TitleBar>
        {badges}
      </div>
      {sub}
      {!!description && (
        <p className="max-w-[65ch] text-sm text-[var(--color-text-secondary)]">{description}</p>
      )}
    </div>
  );
}

/** One container and everything under it, as ruled rows indented by a hairline. */
function ContainerBranch({ container }: { container: Rec }) {
  const items = (container.items as Rec[] | undefined) ?? [];
  const children = (container.children as Rec[] | undefined) ?? [];
  const count = items.length;

  return (
    <div>
      <RuledRow
        leading={<Package className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />}
        title={str(container.name)}
        titleTrailing={container.type ? <Badge>{str(container.type)}</Badge> : undefined}
        meta={meta(str(container.qrCode) || null, str(container.description) || null)}
        trailing={
          count > 0 ? (
            <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-[var(--color-text-muted)]">
              {count} {count === 1 ? 'ITEM' : 'ITEMS'}
            </span>
          ) : undefined
        }
      />
      {(items.length > 0 || children.length > 0) && (
        <div className="ml-2 border-l border-[var(--color-rule)] pl-3">
          {items.map((item) => (
            <ItemLine key={str(item.id)} item={item} />
          ))}
          {children.map((child) => (
            <ContainerBranch key={str(child.id)} container={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemLine({ item }: { item: Rec }) {
  const qty = item.quantity != null && Number(item.quantity) > 1 ? `×${str(item.quantity)}` : null;
  return (
    <RuledRow
      leading={<Box className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
      title={str(item.name)}
      titleTrailing={
        item.condition ? (
          <Badge variant={conditionVariant(str(item.condition))}>
            {conditionLabel(str(item.condition))}
          </Badge>
        ) : undefined
      }
      meta={meta(str(item.description) || null)}
      trailing={
        qty ? (
          <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-[var(--color-text-muted)]">
            {qty}
          </span>
        ) : undefined
      }
    />
  );
}

function PropertyView({ entity }: { entity: Rec }) {
  const areas = (entity.areas as Rec[] | undefined) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <EntityHead
        name={str(entity.name)}
        description={str(entity.description) || undefined}
        sub={
          entity.address ? (
            <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              <MapPin className="h-3.5 w-3.5" />
              {str(entity.address)}
            </p>
          ) : undefined
        }
      />

      {areas.length === 0 && <Empty>No rooms have been added to this property yet.</Empty>}

      {areas.map((area) => {
        const containers = (area.containers as Rec[] | undefined) ?? [];
        return (
          <section key={str(area.id)} className="flex flex-col">
            <ColHead>{str(area.name)}</ColHead>
            {containers.length === 0 ? (
              <Empty>Nothing recorded in this room.</Empty>
            ) : (
              containers.map((c) => <ContainerBranch key={str(c.id)} container={c} />)
            )}
          </section>
        );
      })}
    </div>
  );
}

function AreaView({ entity }: { entity: Rec }) {
  const containers = (entity.containers as Rec[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <EntityHead
        name={str(entity.name)}
        icon={<Building2 className="h-4 w-4 text-[var(--color-text-muted)]" />}
        description={str(entity.description) || undefined}
        trail={
          entity.propertyName
            ? [{ id: -1, name: str(entity.propertyName), type: 'property' }]
            : undefined
        }
      />
      <section className="flex flex-col">
        <ColHead>Contents</ColHead>
        {containers.length === 0 ? (
          <Empty>Nothing recorded in this room.</Empty>
        ) : (
          containers.map((c) => <ContainerBranch key={str(c.id)} container={c} />)
        )}
      </section>
    </div>
  );
}

function ContainerView({ entity }: { entity: Rec }) {
  const items = (entity.items as Rec[] | undefined) ?? [];
  const children = (entity.children as Rec[] | undefined) ?? [];
  const trail =
    (entity.breadcrumb as { id: number; name: string; type: string }[] | undefined) ??
    ([
      entity.propertyName && { id: -1, name: str(entity.propertyName), type: 'property' },
      entity.areaName && { id: -2, name: str(entity.areaName), type: 'area' },
    ].filter(Boolean) as { id: number; name: string; type: string }[]);

  return (
    <div className="flex flex-col gap-6">
      <EntityHead
        name={str(entity.name)}
        trail={trail}
        badges={entity.type ? <Badge>{str(entity.type)}</Badge> : undefined}
        description={str(entity.description) || undefined}
      />

      {children.length > 0 && (
        <section className="flex flex-col">
          <ColHead>Containers inside</ColHead>
          {children.map((c) => (
            <ContainerBranch key={str(c.id)} container={c} />
          ))}
        </section>
      )}

      <section className="flex flex-col">
        <ColHead action={items.length ? String(items.length) : undefined}>Items</ColHead>
        {items.length === 0 ? (
          <Empty>This container is empty.</Empty>
        ) : (
          items.map((item) => <ItemLine key={str(item.id)} item={item} />)
        )}
      </section>
    </div>
  );
}

function ItemView({ entity }: { entity: Rec }) {
  const trail = (entity.breadcrumb as { id: number; name: string; type: string }[] | undefined) ?? [];
  const product = entity.product as Rec | null | undefined;
  const files = (entity.files as Rec[] | undefined) ?? [];
  const hasValue = entity.purchasePrice != null || entity.currentValue != null;

  return (
    <div className="flex flex-col gap-6">
      <EntityHead
        name={str(entity.name)}
        trail={trail}
        badges={
          <>
            {!!entity.condition && (
              <Badge variant={conditionVariant(str(entity.condition))}>
                {conditionLabel(str(entity.condition))}
              </Badge>
            )}
            {!!entity.status && <Badge>{str(entity.status)}</Badge>}
            {entity.quantity != null && Number(entity.quantity) > 1 && (
              <Badge>Qty {str(entity.quantity)}</Badge>
            )}
          </>
        }
        description={str(entity.description) || undefined}
      />

      {!!product && (
        <section className="flex flex-col gap-3">
          <ColHead>Product</ColHead>
          {/* The server already allowlists the host (#355); https-only here is
              the belt for a payload cached from before that. */}
          {typeof product.imageUrl === 'string' && product.imageUrl.startsWith('https://') && (
            <img
              src={product.imageUrl}
              alt={str(product.name)}
              className="h-40 w-full max-w-[420px] rounded-[var(--radius-sm)] border border-[var(--color-border)] object-contain"
              style={{ background: 'var(--color-elevated)' }}
            />
          )}
          <Facts
            facts={[
              ['Name', str(product.name) || null],
              ['Brand', str(product.brand) || null],
              ['Category', str(product.category) || null],
            ]}
          />
        </section>
      )}

      {hasValue && (
        <section className="flex flex-col gap-3">
          <ColHead>Value</ColHead>
          <Facts
            facts={[
              ['Purchase price', money(entity.purchasePrice)],
              ['Current value', money(entity.currentValue)],
            ]}
          />
        </section>
      )}

      {files.length > 0 && (
        <section className="flex flex-col gap-3">
          <ColHead action={String(files.length)}>Files</ColHead>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {files.map((f) => {
              const isImage = str(f.mimeType).startsWith('image/');
              return isImage ? (
                <img
                  key={str(f.id)}
                  src={str(f.url ?? f.presignedUrl)}
                  alt={str(f.fileName ?? f.originalName)}
                  className="aspect-square w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] object-cover"
                />
              ) : (
                <div
                  key={str(f.id)}
                  className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-2 text-center font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
                >
                  <FileText className="h-4 w-4" />
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">
                    {str(f.fileName ?? f.originalName, 'File')}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Label/value pairs on the ruled grid — replaces the old grid-cols-2 card. */
function Facts({ facts }: { facts: [string, string | null][] }) {
  const kept = facts.filter(([, v]) => v != null && v !== '');
  if (!kept.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
      {kept.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] py-2"
        >
          <dt className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            {label}
          </dt>
          <dd className="text-sm font-semibold text-[var(--color-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

/** The app's own column ladder (root-layout.tsx) — a share is not a phone column. */
const LADDER = 'md:max-w-[720px] lg:max-w-[900px] xl:max-w-[1100px] 2xl:max-w-[1400px] mx-auto w-full';

export function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = React.useState<ShareEnvelope | null>(null);
  const [share, setShare] = React.useState<ShareMeta | null>(null);
  const view = React.useMemo(() => (data ? normalize(data) : null), [data]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // A stranger has no session and must never be pointed at Entra; someone who
  // IS signed in is almost always the sharer checking their own link, and they
  // do want a way back into the app. So the app link is conditional, not the
  // default, and nothing here gates the shared content on the answer.
  const { user } = useAuth();

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
        // the envelope lives under `data`; older/raw responses may be flat
        setData(((json.data?.entity ?? json.data ?? json) as ShareEnvelope));
        setShare((json.data?.share as ShareMeta | undefined) ?? null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'This link has expired or is invalid.');
      })
      .finally(() => setLoading(false));
  }, [token]);

  const sharedBy = share?.sharedByName ? String(share.sharedByName) : null;
  const expires = formatDate(share?.expiresAt);

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Header — brand and status only. No sidebar, no bottom nav, no ADD:
          this is a no-auth read-only surface and must not wear app chrome. */}
      <header className="sticky top-0 z-10 border-b border-[var(--color-rule)] bg-[var(--color-card)] px-4 py-3">
        <div className={cn(LADDER, 'flex items-center justify-between gap-3')}>
          <div className="flex min-w-0 items-center gap-3">
            <TitleBar>Tally</TitleBar>
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)] sm:inline">
              Shared view · read only
            </span>
          </div>
          {!!user && (
            <Link
              to="/"
              className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--color-primary)] hover:opacity-80"
            >
              Open Tally ›
            </Link>
          )}
        </div>
      </header>

      <main className={cn(LADDER, 'px-4 py-6')}>
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-primary)]" />
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              Loading shared content…
            </p>
          </div>
        )}

        {!loading && !!error && (
          <div className="mx-auto flex max-w-[46ch] flex-col items-center justify-center gap-4 py-20 text-center">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: 'var(--color-red-bg)' }}
            >
              <AlertTriangle className="h-7 w-7 text-[var(--color-red)]" />
            </div>
            <TitleBar>Link unavailable</TitleBar>
            <p className="text-sm text-[var(--color-text-secondary)]">{error}</p>
            <p className="text-sm text-[var(--color-text-muted)]">
              Share links from Tally expire. Ask whoever sent it for a fresh one — there is nothing
              to sign in to here.
            </p>
          </div>
        )}

        {!loading && !error && !!view && (
          <div className="flex flex-col gap-6">
            {/* Who sent this, when it dies, and what "this" even is. A stranger
                lands here cold; without these three lines the page is someone
                else's inventory with no sender, no scope and no shelf life. */}
            <section className="flex flex-col gap-2" data-testid="share-provenance">
              <ColHead action={expires ? `Expires ${expires}` : undefined}>
                {sharedBy ? (
                  <>
                    Shared by <b>{sharedBy}</b>
                  </>
                ) : (
                  'Shared with you'
                )}
              </ColHead>
              <p className="max-w-[70ch] text-sm text-[var(--color-text-secondary)]">
                Tally is a home-inventory app. You are looking at {SCOPE[view.kind]} — read only, no
                account needed. Nothing else in their inventory is reachable from this link.
              </p>
            </section>

            {view.kind === 'property' && <PropertyView entity={view.entity} />}
            {view.kind === 'area' && <AreaView entity={view.entity} />}
            {view.kind === 'container' && <ContainerView entity={view.entity} />}
            {view.kind === 'item' && <ItemView entity={view.entity} />}
          </div>
        )}

        {!loading && !error && !!data && !view && (
          <p className="py-20 text-center text-sm text-[var(--color-text-muted)]">
            This share link points at something this page can't display yet.
          </p>
        )}
      </main>
    </div>
  );
}
