import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';

interface PhotoCameraProps {
  /** Receives the shot as a JPEG File — feed it to the flow's single photo
   *  entry point (capture's acceptPhotoFile), never a parallel path. */
  onCapture: (file: File) => void;
  /**
   * The embedded camera cannot (or should not) run: getUserMedia is missing,
   * it rejected, or the user asked for the OS camera outright. The parent
   * answers by rendering the OS-input button for the rest of ITS mount — a
   * remount retries the embedded camera.
   */
  onFallback: () => void;
}

/**
 * The capture flow's step-1 camera (#226): a live in-page preview with a
 * shutter, replacing the OS-camera `<input capture>` round trip — an
 * app-switch plus a confirm screen per item, hundreds of times a session.
 * Steps 2–3 already run live in-page cameras; this brings step 1 up to par.
 *
 * No decode loop and no library — just getUserMedia and a `<video>` — but the
 * stream lifecycle follows camera-scanner.tsx's hard-won rules:
 *
 * - Acquire IN the effect, release in THAT effect's cleanup. StrictMode dev
 *   runs mount → cleanup → mount, so each effect run owns its own `cancelled`
 *   flag and its own stream; a component-level "mounted" ref that cleanup
 *   flips and nothing re-arms would leave the second mount dead. A stream
 *   resolving after its effect was cleaned up is stopped on the spot — the
 *   unbounded first-run-permission-prompt window camera-scanner documents.
 * - Release on visibilitychange→hidden, re-acquire on visible. The OS drops
 *   backgrounded cameras anyway; releasing eagerly makes the state honest and
 *   the return path deterministic. (This component only mounts while the
 *   flow's phase is `photo`, so "while phase is photo" is structural.)
 * - Track.stop() is synchronous in cleanup, so this camera is fully released
 *   before the barcode/tag scanner phases mount — one camera at a time.
 *
 * The shutter draws the CURRENT frame to a canvas at the stream's own
 * videoWidth×videoHeight (the preview's object-cover crop is presentation,
 * not the picture) and encodes JPEG at 0.85. There is no confirm step: the
 * identify phase's draft-strip thumbnail is the review surface, and a bad
 * shot is retaken from there by discarding the draft.
 */
export function PhotoCamera({ onCapture, onFallback }: PhotoCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** True once loadedmetadata reports real dimensions — the shutter's gate.
   *  A stream with videoWidth 0 has no frame to draw; capturing it produces
   *  a 0×0 canvas whose toBlob yields null (or a garbage file). */
  const [ready, setReady] = useState(false);
  // Refs, not deps: the acquire/release effect must run exactly once per
  // mount, and the callbacks it needs can be re-created by parent renders.
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  useEffect(() => {
    // Owned by THIS effect run: cleanup sets it, and the next run (StrictMode
    // remount, or a real remount) starts with a fresh false of its own.
    let cancelled = false;
    let stream: MediaStream | null = null;

    const release = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
      setReady(false);
    };

    const acquire = async () => {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) {
        // No embedded path exists at all — hand step 1 back to the OS input.
        onFallbackRef.current();
        return;
      }
      let next: MediaStream;
      try {
        next = await media.getUserMedia({ video: { facingMode: 'environment' } });
      } catch {
        // Denied, no device, hardware wedged — the OS picker may still work
        // (it runs its own permission surface), so fall back rather than
        // dead-ending step 1 behind a retry button.
        if (!cancelled) onFallbackRef.current();
        return;
      }
      if (cancelled || document.visibilityState === 'hidden') {
        // The answer arrived after the question stopped mattering — a slow
        // permission prompt outlives unmounts and backgroundings.
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      release(); // two visible-events can race two acquires; never hold both
      stream = next;
      const video = videoRef.current;
      if (video) {
        video.srcObject = next;
        // autoPlay covers the normal path; the explicit call covers browsers
        // that want a fresh play() after srcObject changes. Rejections
        // (autoplay policy, jsdom's stub) are non-fatal — the muted+playsInline
        // combination is exactly what mobile autoplay policies permit.
        try { void video.play()?.catch(() => { /* autoplay-blocked */ }); } catch { /* jsdom */ }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
      else void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, []);

  function shutter() {
    const video = videoRef.current;
    // Belt to the disabled-button's braces: `ready` is state, dimensions are
    // the ground truth, and a hidden-released stream zeroes them first.
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCaptureRef.current(new File([blob], 'capture.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  }

  return (
    <div className="flex flex-col gap-1">
      {/* The height cap is the audited tablet clamp from the button this
          replaces; on a phone 50vh lands in the same range. The video is
          absolutely filled + object-cover, so the element's CSS box — not the
          stream's natural size — owns the layout: a portrait phone stream can
          never blow the page up the way width-sized video elements do. */}
      <div className="relative w-full h-[clamp(260px,50vh,420px)] overflow-hidden rounded-[var(--radius-sm)] border-2 border-[var(--color-text)] bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          onLoadedMetadata={() => setReady((videoRef.current?.videoWidth ?? 0) > 0)}
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* The instruction sits on the viewfinder, where the eye already is —
            same placement rule as camera-scanner's label. */}
        <div className="absolute top-2 left-10 right-10 flex justify-center pointer-events-none z-10">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-white text-center leading-6 px-2 rounded-[var(--radius-sm)] bg-black/55 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
            Take a photo of the item
          </span>
        </div>

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)]">
            <Camera className="w-10 h-10 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Starting camera...</p>
          </div>
        )}

        {/* left is a token, not 1/2: --shutter-x is 50% everywhere except a
            coarse pointer on a tablet-width viewport, where the thumbs are on
            the side bezels and frame-centre is 250-540px out of reach. See
            globals.css for the measurements and why 768px is the gate. The
            -translate-x-1/2 stays either way — the token is the button's
            CENTRE, so the same class positions both cases. */}
        <button
          type="button"
          aria-label="Take photo"
          disabled={!ready}
          onClick={shutter}
          className="absolute bottom-3 left-[var(--shutter-x)] -translate-x-1/2 z-10 w-16 h-16 rounded-full border-4 border-white bg-white/30 active:scale-95 transition-transform disabled:opacity-40"
        />
      </div>

      {/* The escape hatch for a stream that came up black or aimed wrong —
          a live preview can be technically fine and practically useless. */}
      <button
        type="button"
        onClick={onFallback}
        className="self-center min-h-[max(36px,var(--tap-min))] px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] underline decoration-dotted"
      >
        Use system camera
      </button>
    </div>
  );
}
