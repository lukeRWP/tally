import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScanLine, ArrowRight } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { extractTlyCode } from '@/lib/tly';

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

  // TagScanner hands over an already-extracted code, but the typed field below
  // accepts anything a person can paste — including the full label URL, which
  // is what you get from a phone's share sheet after scanning one. Run it
  // through the same parser rather than trusting the caller.
  // /s/:code resolves the label and redirects to whatever it is on.
  const handleCode = useCallback((raw: string) => {
    const code = extractTlyCode(raw);
    if (!code) { toast('That is not a tally tag'); return; }
    navigate(`/s/${encodeURIComponent(code)}`);
  }, [navigate]);

  return (
    <div className="flex flex-col gap-3 max-w-lg mx-auto h-full">
      <TitleBar className="w-fit shrink-0">Scan a tag</TitleBar>

      <TagScanner onTag={handleCode} onClose={() => navigate(-1)} />

      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] text-center shrink-0">
        Takes you to whatever the label is on
      </p>

      {/* A damaged or unreadable label still has its code printed on it. */}
      <form
        className="flex gap-2 shrink-0"
        onSubmit={(e) => { e.preventDefault(); if (typed.trim()) handleCode(typed); }}
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Or type the code (TLY-…)"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Button size="sm" type="submit" className="shrink-0" disabled={!typed.trim()}>
          <ArrowRight className="w-4 h-4" />
          Go
        </Button>
      </form>

      <p className="flex items-start gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] pt-2 shrink-0">
        <ScanLine className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Adding an item is the Add button · putting one away is Move</span>
      </p>
    </div>
  );
}

export default Scan;
