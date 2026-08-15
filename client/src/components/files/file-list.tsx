import * as React from 'react';
import { FileText, Image, Receipt, File, Trash2, Image as ImageIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { useItemFiles, useDeleteFile } from '@/hooks/use-files';
import type { ItemFile } from '@/types/files';
import { cn } from '@/lib/utils';

const FILE_TYPE_ORDER = ['receipt', 'warranty', 'manual', 'photo', 'other'] as const;

function fileIcon(fileType: ItemFile['fileType']) {
  switch (fileType) {
    case 'photo':
      return <Image className="w-4 h-4 shrink-0 text-[var(--color-primary)]" />;
    case 'receipt':
      return <Receipt className="w-4 h-4 shrink-0 text-[var(--color-amber)]" />;
    case 'manual':
    case 'warranty':
      return <FileText className="w-4 h-4 shrink-0 text-[var(--color-text-secondary)]" />;
    default:
      return <File className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />;
  }
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface FileRowProps {
  file: ItemFile;
  itemId: number;
}

function FileRow({ file, itemId }: FileRowProps) {
  const deleteFile = useDeleteFile();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function handleDelete() {
    setConfirmOpen(false);
    try {
      await deleteFile.mutateAsync({ fileId: file.id, itemId });
      toast.success('File deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div className="flex items-center gap-2 py-2 border-b border-[var(--color-border)] last:border-0">
      {fileIcon(file.fileType)}
      <button
        type="button"
        className="flex-1 text-left min-w-0 cursor-pointer hover:underline"
        onClick={() => file.url && window.open(file.url, '_blank')}
      >
        <p className="text-xs font-medium text-[var(--color-text)] truncate">{file.fileName}</p>
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {humanSize(file.fileSize)} &middot; {formatDate(file.createdAt)}
        </p>
      </button>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={deleteFile.isPending}
        className={cn(
          'p-1.5 rounded-[var(--radius-md)] text-[var(--color-text-muted)]',
          'hover:text-[var(--color-red)] hover:bg-[var(--color-red-bg)] transition-colors cursor-pointer',
          'disabled:opacity-50 disabled:pointer-events-none'
        )}
        aria-label="Delete file"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${file.fileName}"?`}
        description="This permanently removes the attached file."
        destructive
        confirmLabel="Delete"
        isPending={deleteFile.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

interface FileListProps {
  itemId: number;
  /**
   * Which attachments to show.
   *
   * 'photos' and 'documents' are the same table and different things: a photo
   * is looked AT, a receipt or a manual is opened and read. Splitting them
   * means each can be presented the way it wants to be, and neither buries the
   * other in a list ordered by upload date.
   */
  only?: 'photos' | 'documents';
}

export function FileList({ itemId, only }: FileListProps) {
  const { data: all, isLoading } = useItemFiles(itemId);
  const files = React.useMemo(() => {
    const list = all ?? [];
    if (only === 'photos') return list.filter((f) => f.fileType === 'photo');
    if (only === 'documents') return list.filter((f) => f.fileType !== 'photo');
    return list;
  }, [all, only]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-1">
        {only === 'photos' ? 'No photos yet.' : only === 'documents' ? 'No documents yet.' : 'No files attached yet.'}
      </p>
    );
  }

  /*
   * Photos are shown, not listed.
   *
   * "drill-side.jpg · 234.5 KB" tells you a photo exists and nothing about
   * what is in it, which is the only thing anyone opens a photo panel to find
   * out. A filename is the right row for a manual — you already know what a
   * manual looks like — and the wrong one for a picture.
   */
  if (only === 'photos') {
    return (
      <div className="grid grid-cols-3 gap-2 pt-1">
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => file.url && window.open(file.url, '_blank')}
            title={file.fileName}
            className="group relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-elevated)] hover:border-[var(--color-text)]"
          >
            {file.url ? (
              <img src={file.url} alt={file.fileName} loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                <ImageIcon className="h-5 w-5" />
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  // Group by file type in display order. The photos panel returned above, so
  // everything still here has more than one kind to separate and wants the
  // headings — the flag that used to suppress them has no case left.
  const grouped = FILE_TYPE_ORDER.reduce<Record<string, ItemFile[]>>((acc, type) => {
    const group = files.filter((f) => f.fileType === type);
    if (group.length) acc[type] = group;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(grouped).map(([type, group]) => (
        <div key={type}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
            {type}
          </p>
          <div>
            {group.map((file) => (
              <FileRow key={file.id} file={file} itemId={itemId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
