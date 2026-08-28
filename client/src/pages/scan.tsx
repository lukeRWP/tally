import * as React from 'react';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScanLine, ArrowRight } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { extractTlyCode } from '@/lib/tly';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';

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
  const atDesk = useLayoutMode() === 'sidebar';
  const coarse = useCoarsePointer();
  // Scanner where a rear camera plausibly exists: phones, and tablets in
  // landscape (sidebar chrome + coarse pointer — see use-coarse-pointer.ts
  // for why camera-presence is NOT the test). Fine-pointer desks keep the
  // typed-first flow with an opt-in camera below.
  const showScanner = !atDesk || coarse;
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const codeRef = React.useRef<HTMLInputElement>(null);
  // The field is the FINE-POINTER desk's primary control, so it is ready for
  // a typed code or a USB reader the moment the page opens. A coarse desk has
  // the scanner as its primary control instead (showScanner above), so it is
  // never autofocused there — popping the on-screen keyboard on open, on top
  // of a viewfinder, is not a landing anyone wants.
  React.useEffect(() => { if (atDesk && !coarse) codeRef.current?.focus(); }, [atDesk, coarse]);
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

  /*
   * At a FINE-POINTER desk the camera is the exception, not the default.
   *
   * Leading with the viewfinder there produced a 420px panel reading "Camera
   * access denied" in red with a Try Again button — an error presented as the
   * main event, for a device that simply has no camera — and pushed the typed
   * field, the ONE thing that works, 450px down the page.
   *
   * So the order inverts: type the code first, and the camera is available if
   * you actually have one to hold a label up to. A USB QR reader is a keyboard,
   * so it lands in the same field.
   *
   * A coarse-pointer desk (a landscape iPad) is a different device with a
   * different answer — it plausibly has a rear camera, so it gets the same
   * scanner-first flow as a phone (showScanner above), and this reasoning
   * applies only to the mouse-and-keyboard desk left behind by that fork.
   */
  const codeForm = (
    <form
      className="flex gap-2 shrink-0"
      onSubmit={(e) => { e.preventDefault(); if (typed.trim()) handleCode(typed); }}
    >
      <Input
        ref={atDesk && !coarse ? codeRef : undefined}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={showScanner ? 'Or type the code (TLY-…)' : 'Type or scan a code (TLY-…)'}
        autoCapitalize="characters"
        spellCheck={false}
      />
      <Button size="sm" type="submit" className="shrink-0" disabled={!typed.trim()}>
        <ArrowRight className="w-4 h-4" />
        Go
      </Button>
    </form>
  );

  return (
    <div className={cn('flex flex-col gap-3 mx-auto h-full', atDesk ? 'w-full max-w-[640px]' : 'max-w-lg')}>
      <TitleBar className="w-fit shrink-0">Scan a tag</TitleBar>

      {!showScanner ? (
        <>
          {codeForm}
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] shrink-0">
            Takes you to whatever the label is on
          </p>
          {/* Opt-in, so a machine without a camera never shows a denial. */}
          {cameraOpen ? (
            <TagScanner onTag={handleCode} onClose={() => setCameraOpen(false)} />
          ) : (
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setCameraOpen(true)}>
              <ScanLine className="w-4 h-4" />
              Use the camera instead
            </Button>
          )}
        </>
      ) : (
        <>
          {/* html5-qrcode sizes its video by width only, so on a wide
              landscape tablet the stream would otherwise take over the page —
              the cap is tablet-only; the phone wrapper is unstyled. The base
              classes (flex flex-col flex-1 min-h-0) are NOT decoration — this
              wrapper is a flex item of the page column above, which needs
              them at every level for TagScanner's own flex-1 to actually grow
              (a classless-on-phone wrapper collapses it — see put-down.tsx /
              capture.tsx for the ~200px regression this idiom exists to
              avoid). The clamp binds on tablets only. */}
          <div className={cn('flex flex-col flex-1 min-h-0', atDesk && coarse && 'max-h-[clamp(230px,36vh,280px)] overflow-hidden')}>
            <TagScanner onTag={handleCode} onClose={() => navigate(-1)} />
          </div>

          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] text-center shrink-0">
            Takes you to whatever the label is on
          </p>

          {/* A damaged or unreadable label still has its code printed on it. */}
          {codeForm}
        </>
      )}

      <p className="flex items-start gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] pt-2 shrink-0">
        <ScanLine className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Adding an item is the Add button · putting one away is Move</span>
      </p>
    </div>
  );
}

export default Scan;
