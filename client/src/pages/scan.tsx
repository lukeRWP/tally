import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScanLine, ArrowRight } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TitleBar } from '@/components/ui/title-bar';

/**
 * Scan a tag.
 *
 * This screen reads the labels tally itself generates and you print — an area
 * or a bin — and takes you to what the label is on. That is its whole job.
 *
 * It used to also be the place you added items: a product-barcode lookup, a
 * catalogue search, a URL paste and a create form, behind a tab switcher
 * shared with a move mode. Adding an item is /capture's three steps and only
 * those, so all of that has moved there or gone. A screen that answers one
 * question does not need a tab bar.
 *
 * A product barcode is not an error here — it is just not a tally tag, and the
 * flow that wants one is named.
 */

export function Scan() {
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');

  // The scanner only decodes QR and only accepts tally's own tags, so by the
  // time a code arrives here it is a real one — this just goes there.
  // /s/:code resolves the label and redirects to whatever it is on.
  const handleCode = useCallback((code: string) => {
    navigate(`/s/${encodeURIComponent(code.trim().toUpperCase())}`);
  }, [navigate]);

  return (
    <div className="flex flex-col gap-3 p-4 pb-28 max-w-lg mx-auto">
      <TitleBar className="w-fit">Scan a tag</TitleBar>

      <TagScanner onTag={handleCode} onClose={() => navigate(-1)} />

      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] text-center">
        Takes you to whatever the label is on
      </p>

      {/* A damaged or unreadable label still has its code printed on it. */}
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); if (typed.trim()) handleCode(typed); }}
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Or type the code (TLY-…)"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Button size="sm" type="submit" disabled={!typed.trim()}>
          <ArrowRight className="w-4 h-4" />
          Go
        </Button>
      </form>

      <p className="flex items-start gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] pt-2">
        <ScanLine className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Adding an item is the Add button · putting one away is Move</span>
      </p>
    </div>
  );
}

export default Scan;
