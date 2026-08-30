import * as React from 'react';
import { Copy, Trash2, Loader2, Link2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ShareUrl } from './share-url';
import { useMyShareLinks, useCreateShareLink, useRevokeShareLink } from '@/hooks/use-sharing';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

interface ShareDialogProps {
  entityType: string;
  entityId: number;
  entityName: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

const EXPIRY_OPTIONS = [
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function ShareDialog({ entityType, entityId, entityName, isOpen, onOpenChange }: ShareDialogProps) {
  const [expiresInDays, setExpiresInDays] = React.useState(7);
  const [newLinkUrl, setNewLinkUrl] = React.useState<string | null>(null);

  const { data: allLinks, isLoading: linksLoading } = useMyShareLinks();
  const createLink = useCreateShareLink();
  const revokeLink = useRevokeShareLink();

  // Filter links for this specific entity
  const entityLinks = React.useMemo(
    () =>
      (allLinks as unknown as { id: number; token: string; entityType: string; entityId: number; url: string; expiresAt: string; createdAt: string }[] | undefined)?.filter(
        (l) => l.entityType === entityType && l.entityId === entityId,
      ) ?? [],
    [allLinks, entityType, entityId],
  );

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!isOpen) {
      setNewLinkUrl(null);
      setExpiresInDays(7);
    }
  }, [isOpen]);

  function handleGenerate() {
    createLink.mutate(
      { entityType, entityId, expiresInDays },
      {
        onSuccess: (link) => {
          const linkData = link as unknown as { url: string };
          setNewLinkUrl(linkData.url);
          toast.success('Share link created');
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleCopy(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied to clipboard'),
      () => toast.error('Failed to copy link'),
    );
  }

  function handleRevoke(id: number) {
    revokeLink.mutate(id, {
      onSuccess: () => {
        toast.success('Share link revoked');
        if (newLinkUrl) setNewLinkUrl(null);
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md mx-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-[var(--color-primary)]" />
            Share "{entityName}"
          </DialogTitle>
          <DialogDescription>
            Generate a read-only link that anyone can view without signing in.
          </DialogDescription>
        </DialogHeader>

        {/* Expiry selector */}
        <div>
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Link expires in</p>
          <div className="flex gap-2">
            {EXPIRY_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setExpiresInDays(opt.days)}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-all border',
                  expiresInDays === opt.days
                    ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                    : 'bg-[var(--color-elevated)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        <Button
          onClick={handleGenerate}
          disabled={createLink.isPending}
          className="w-full"
        >
          {createLink.isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating…
            </>
          ) : (
            'Generate Link'
          )}
        </Button>

        {/* Newly created link. The URL is an anchor, not a readonly input: the
            only way to check what you just published is to open it, and a
            desk has tabs. Copy stays alongside for pasting it elsewhere. */}
        {newLinkUrl && (
          <div className="flex gap-2 items-center">
            <ShareUrl url={newLinkUrl} />
            <Button size="sm" variant="outline" onClick={() => handleCopy(newLinkUrl)} title="Copy link">
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Existing links */}
        {linksLoading && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading links…
          </div>
        )}

        {!linksLoading && entityLinks.length > 0 && (
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Active links</p>
            <div className="flex flex-col gap-2">
              {entityLinks.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] border border-[var(--color-border)]"
                >
                  <div className="flex-1 min-w-0">
                    <ShareUrl url={link.url} />
                    <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                      Expires {formatDate(link.expiresAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCopy(link.url)}
                    className="shrink-0"
                    title="Copy link"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleRevoke(link.id)}
                    disabled={revokeLink.isPending}
                    className="shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
