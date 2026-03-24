import * as React from 'react';
import { Upload, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useUploadFile } from '@/hooks/use-files';

const FILE_TYPES = ['receipt', 'warranty', 'manual', 'photo', 'other'] as const;
type FileType = (typeof FILE_TYPES)[number];

interface FileUploadProps {
  itemId: number;
}

export function FileUpload({ itemId }: FileUploadProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [fileType, setFileType] = React.useState<FileType>('other');
  const upload = useUploadFile();

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
  }

  async function handleUpload() {
    if (!selectedFile) return;
    try {
      await upload.mutateAsync({ itemId, file: selectedFile, fileType });
      toast.success('File uploaded');
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-[var(--color-border)]">
      <p className="text-xs font-medium text-[var(--color-text-muted)]">Attach a file</p>

      {/* File type pills */}
      <div className="flex flex-wrap gap-1.5">
        {FILE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setFileType(type)}
            className={cn(
              'px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors cursor-pointer',
              fileType === type
                ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]'
            )}
          >
            {type}
          </button>
        ))}
      </div>

      {/* File picker + upload row */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex-1 flex items-center gap-2 px-3 h-9 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)]',
            'text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)] transition-colors cursor-pointer'
          )}
        >
          <Paperclip className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            {selectedFile ? selectedFile.name : 'Choose file…'}
          </span>
        </button>
        <Button
          size="sm"
          disabled={!selectedFile || upload.isPending}
          onClick={handleUpload}
        >
          <Upload className="w-3.5 h-3.5" />
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
    </div>
  );
}
