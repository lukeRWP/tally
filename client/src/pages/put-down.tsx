import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, List, Undo2, X } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { DestinationPicker } from '@/components/inventory/destination-picker';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCarryStore } from '@/store/carry-store';
import { usePutDown } from '@/hooks/use-put-down';
import { useMoveItem, useMoveContainer } from '@/hooks/use-inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';

/**
 * Put it down.
 *
 * Scanning is not one activity. Adding an item asks "what is this?" and wants a
 * product barcode; putting something away asks "where does this go?" and wants
 * a bin label. They were the same screen, so tapping Move on an item opened a
 * page offering to add an item and search a product catalogue — an answer to a
 * question nobody had asked.
 *
 * This screen has exactly one question. Every code it sees is read as a
 * destination: a bin nests or receives, an area takes the load into its
 * catch-all. A product barcode is not an error, it is just the wrong kind of
 * answer, and is told so.
 */

interface ResolvedEntity {
  type: string;
  id: number;
  name: string;
  exists: boolean;
}

export function PutDown() {
  const atDesk = useLayoutMode() === 'sidebar';
  const navigate = useNavigate();
  const carried = useCarryStore((s) => s.carried);
  const lastMove = useCarryStore((s) => s.lastMove);
  const clear = useCarryStore((s) => s.clear);
  const clearLastMove = useCarryStore((s) => s.clearLastMove);
  const putDown = usePutDown();
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();

  const [picking, setPicking] = React.useState(atDesk);
  const [busy, setBusy] = React.useState(false);

  // The scanner callback is handed to the camera once, so it must not close
  // over a stale load.
  const carriedRef = React.useRef(carried);
  React.useEffect(() => { carriedRef.current = carried; }, [carried]);

  const bins = carried.filter((c) => c.kind === 'container').length;
  const items = carried.length - bins;
  const summary = carried.length === 1
    ? carried[0].name
    : [bins ? `${bins} ${bins === 1 ? 'bin' : 'bins'}` : null,
       items ? `${items} ${items === 1 ? 'item' : 'items'}` : null].filter(Boolean).join(' + ');

  const land = React.useCallback(async (dest: { type: string; id: number; name: string }) => {
    setBusy(true);
    try {
      const result = await putDown(carriedRef.current, dest);
      if (!result) {
        toast(`Already in ${dest.name}`);
        return;
      }
      toast.success(
        result.moved.length === 1
          ? `${result.moved[0].name} → ${dest.name}`
          : `${result.moved.length} moved → ${dest.name}`,
      );
      // Go to where it landed: the point of the move is that the thing is now
      // somewhere, and this shows you it is.
      if (dest.type === 'area') navigate(`/area/${dest.id}`);
      else navigate(`/container/${dest.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move it there');
    } finally {
      setBusy(false);
    }
  }, [putDown, navigate]);

  // Only tally tags reach here — the scanner decodes nothing else — so this
  // only has to decide whether the tag names somewhere a load can go.
  const handleCode = React.useCallback(async (code: string) => {
    try {
      const entity = await api.get<ResolvedEntity>(
        `/api/labels/_x_/resolve/${encodeURIComponent(code)}`,
      );
      if (!entity?.exists) {
        toast.error(`Code ${code} is not in your inventory`);
        return;
      }
      if (entity.type !== 'container' && entity.type !== 'area') {
        toast.error('That label is not a bin or an area');
        return;
      }
      await land(entity);
    } catch {
      toast.error('Could not read that label');
    }
  }, [land]);

  async function undo() {
    if (!lastMove) return;
    const reversible = lastMove.items.filter((i) => i.fromContainerId || i.fromAreaId);
    try {
      await Promise.all(
        reversible.map((i) =>
          i.kind === 'container'
            ? moveContainer.mutateAsync(
                i.fromContainerId
                  ? { id: i.id, parentContainerId: i.fromContainerId }
                  : { id: i.id, parentContainerId: null, areaId: i.fromAreaId as number },
              )
            : moveItem.mutateAsync({ id: i.id, containerId: i.fromContainerId as number }),
        ),
      );
      const skipped = lastMove.items.length - reversible.length;
      toast(
        skipped > 0
          ? `Put ${reversible.length} back — ${skipped} had no previous home`
          : 'Put back',
      );
      clearLastMove();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the move');
    }
  }

  // Nothing in hand: this screen has no question to ask.
  if (carried.length === 0) {
    return (
      <div className="flex flex-col gap-4 max-w-lg mx-auto">
        <TitleBar className="w-fit">Move</TitleBar>
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <PackageOpen className="w-7 h-7 text-[var(--color-text-muted)]" />
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Nothing in hand
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-xs">
            Pick something up first — tap <b>Move</b> on an item or a bin, or select several
            inside a bin and move them together.
          </p>
          {lastMove && (
            <Button variant="outline" size="sm" className="mt-2" onClick={undo}>
              <Undo2 className="w-4 h-4" />
              Undo the last move
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-w-lg mx-auto h-full">
      {/* What is in your hands, and the one question this screen asks. */}
      <div className="flex items-center gap-2 border-2 border-[var(--color-primary)] bg-[var(--color-primary-bg)] rounded-[var(--radius-sm)] px-3 py-2 shrink-0">
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-primary)] font-bold">
            carrying
          </span>
          <span className="block text-sm font-semibold truncate">{summary}</span>
          {carried.length === 1 && carried[0].fromContainerName && (
            <span className="block font-mono text-[10px] text-[var(--color-text-muted)] truncate">
              from {carried[0].fromContainerName}
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label="Put down without moving"
          onClick={() => { clear(); navigate(-1); }}
          className="shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-primary)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {picking ? (
        <DestinationPicker
          seedAreaId={carried[0]?.fromAreaId}
          onPick={(bin) => { setPicking(false); void land({ type: 'container', id: bin.id, name: bin.name }); }}
          onClose={() => setPicking(false)}
        />
      ) : (
        <>
          {/* The action is drawn inside the frame, so it is read while aiming.
              It doubles as the progress indicator while the move is in flight. */}
          {/* At a desk the camera is opt-in: the picker above is the path that
              works, and leading with a viewfinder there shows a denial for a
              device that has no camera to deny. */}
          {!atDesk && (
            <TagScanner
              label={busy ? 'Moving…' : 'Scan tote/area tag'}
              onTag={handleCode}
              onClose={() => navigate(-1)}
            />
          )}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPicking(true)}>
            <List className="w-4 h-4" />
            Pick a bin from the list
          </Button>
        </>
      )}
    </div>
  );
}

export default PutDown;
