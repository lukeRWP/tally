import { useState } from 'react';
import { Link, Loader2, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface UrlExtractorProps {
  onProductExtracted: (product: Record<string, unknown>) => void;
}

export function UrlExtractor({ onProductExtracted }: UrlExtractorProps) {
  const [url, setUrl] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExtract() {
    if (!url.trim()) return;
    setIsExtracting(true);
    setError(null);
    try {
      const data = await api.post<{ product: Record<string, unknown> }>(
        '/api/products/_y_/extract-url',
        { url: url.trim() }
      );
      if (data.product) {
        onProductExtracted(data.product);
        setUrl('');
      } else {
        setError('No product details found on that page');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract product');
    } finally {
      setIsExtracting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-[var(--color-text-secondary)] flex items-center gap-1">
        <Link className="w-3 h-3" />
        Paste a product URL
      </label>
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          placeholder="https://amazon.com/dp/..."
          className="flex-1 text-xs"
          onKeyDown={(e) => { if (e.key === 'Enter') handleExtract(); }}
        />
        <Button
          size="sm"
          onClick={handleExtract}
          disabled={!url.trim() || isExtracting}
          className="shrink-0"
        >
          {isExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Fetch'}
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-1 text-[10px] text-[var(--color-red)]">
          <AlertCircle className="w-3 h-3 shrink-0" />
          {error}
        </div>
      )}
      <p className="text-[10px] text-[var(--color-text-muted)]">
        Works with Amazon, Walmart, Target, Best Buy, and most product pages
      </p>
    </div>
  );
}
