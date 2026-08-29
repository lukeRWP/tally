# Scanner migration — off html5-qrcode: plan

**Goal:** replace `html5-qrcode` — the decode engine behind every live
scanner surface — with a maintained stack, without changing what any
consumer sees. Closes #96.

**Status:** committed plan, 2026-08-29. This is a PLAN, not an
implementation; no production code changes ride with it.

**Why now-ish:** `html5-qrcode` last published **2.3.8 on 2023-04-15**
(npm registry, verified 2026-08-29) — three and a half years dead, issues
unanswered, and it embeds its own fork of the also-stalled zxing-js
TypeScript port. Nothing is broken today; the risk is that the first
mobile-Safari behavior change that does break it leaves us patching a
corpse under time pressure. Non-emergency, so we migrate on our schedule,
behind the wrapper boundary built for exactly this.

---

## 1. What we actually use (the wrapper, catalogued)

`client/src/components/scanner/camera-scanner.tsx` is the **single**
import site of `Html5Qrcode`. The whole library dependency surface is:

- **Constructor:** `new Html5Qrcode(elementId, { formatsToSupport, verbose: false })`.
- **Formats** (`Html5QrcodeSupportedFormats`): `QR_CODE`, `UPC_A`, `UPC_E`,
  `EAN_13`, `EAN_8`, `CODE_128`, `CODE_39` — the default union. The two
  thin consumers narrow it deliberately:
  - `tag-scanner.tsx`: **QR only** (TLY tags; a tag scanner that cannot
    read a UPC can never mistake a cereal box for a shelf).
  - `product-scanner.tsx`: **1D only** — UPC-A/E, EAN-13/8, Code 128,
    Code 39, deliberately excluding QR (a product scanner that cannot read
    QR never swallows a bin label mid-naming).
  The enum is imported by both consumers — the only html5-qrcode imports
  outside the wrapper. **The replacement must preserve the narrowing knob.**
- **`start()`:** camera constraint `{ facingMode: 'environment' }` (never
  a deviceId — no camera picker anywhere), config
  `{ fps: 15, qrbox: { width: w, height: h } }`, a success callback
  (decoded text), and a no-op failure callback.
- **qrbox geometry:** computed from the container's `clientWidth` —
  `w = min(floor(width * 0.8), 300)`, `h = floor(w * 0.6)` — a landscape
  box tuned for 1D barcodes. The bracket overlay is drawn on **exactly
  this box**, centred in the frame, because the decode region is the
  centred qrbox, not the visible frame (the lesson: frame-pinned brackets
  over-claimed the readable area by 1.6–3.6×).
- **Lifecycle:** `stop()` + `clear()`, serialised through one promise
  chain with a `desired` ref as the single source of truth — because the
  library's own `getState()` could not be trusted during startup (a stop
  landing inside `camera.render()`'s window leaked a live, unreachable
  camera). Teardown also `replaceChildren()`s the container because the
  library litters the DOM it owns.
- **Dedupe:** same-code refires suppressed while continuously visible
  (2 s sliding window, refreshed on every sighting) — wrapper logic, not
  library.
- **Error path:** start-rejection → message + "Try again" button, which
  re-enqueues bring-up. Manual Stop/Start buttons flip `desired` and
  enqueue.
- **DOM/CSS contract the library forces:** the library sizes its video
  from `#scannerId`'s clientWidth **only** — a portrait phone stream blows
  the page up vertically unless the *outer* div carries the clip
  (`min-h-[220px] max-h-[420px] overflow-hidden`), and `#scannerId` itself
  must stay unconstrained or the shaded-region math collapses. Consumers
  add their own flex-chain caps on top (capture's tablet
  `max-h-[clamp(…)]` wrappers, the `flex flex-col flex-1 min-h-0`
  contract at every level).
- **No use of:** `Html5QrcodeScanner` (the bundled UI), file-based
  scanning, torch/zoom, camera enumeration, or the library's built-in
  native-BarcodeDetector experimental flag.

### Consumers (the API surface that must not move)

| Surface | Component | Props used |
|---|---|---|
| `/capture` step 2 (identify) | `ProductScanner` | `label`, `onBarcode`, `onClose` |
| `/capture` step 3 (place) | `TagScanner` | `label`, `onTag`, `onClose` |
| `/scan` (two variants) | `TagScanner` | `onTag`, `onClose` |
| `/move` (put-down, gather + distribute) | `TagScanner` ×2 | `onTag`, `onClose`, `label` |

`CameraScanner`'s own contract: `{ onBarcodeScanned, onClose, isActive,
label?, formats? }`. Every page-level vitest suite mocks
`ProductScanner`/`TagScanner` wholesale, so **the component boundary is
also the test boundary** — internals can be rebuilt freely; the props
cannot.

---

## 2. The candidates, verified 2026-08-29

### Native `BarcodeDetector` — the deciding fact

caniuse (`mdn-api_barcodedetector`, fetched 2026-08-29): **Safari — not
supported, any version, desktop or iOS** (at best "disabled by default");
Firefox — not supported; Chromium — *partial* support since 83, full only
on Android/Samsung Internet. This household is **iPhone/iPad-first**:
every real pocket device that scans a bin is Safari/WebKit. So a
"native-first with library fallback" architecture is a fiction here — the
fallback library would be the primary path on every device that matters,
and the native path would exercise only desktop Chrome, where caniuse
still says *partial* (desktop Shape Detection is the API's flakiest
platform). Native `BarcodeDetector` is therefore **not a candidate as an
engine** — it survives only as an API *shape* to code against.

### `barcode-detector` (Sec-ant) + `zxing-wasm` — recommended

- **Maintenance:** `barcode-detector` 3.2.2 published **2026-08-16**;
  `zxing-wasm` 3.1.3 published **2026-08-14** (npm registry). Actively
  maintained, single motivated maintainer, wraps **zxing-cpp** — the one
  ZXing lineage still under real development.
- **API:** a spec-faithful W3C `BarcodeDetector` ponyfill
  (`barcode-detector/ponyfill`) — `new BarcodeDetector({ formats })`,
  `detect(source)` where source includes an `HTMLVideoElement`. Coding
  against the spec shape means the native path is available later by
  swapping one import (the `/polyfill` entry registers only when native is
  absent) — but see the recommendation: we deliberately do **not** take
  native-when-available.
- **Formats:** `qr_code`, `upc_a`, `upc_e`, `ean_13`, `ean_8`,
  `code_128`, `code_39` all supported (plus ~30 more). Exact 1:1 mapping
  for our enum.
- **Stream ownership:** none — it is a pure detector. **We** own
  getUserMedia, the `<video>`, and the loop. That is precisely the
  convergence with `photo-camera.tsx` this plan wants.
- **The one trap:** by default the `.wasm` is fetched from **jsDelivr**.
  Unacceptable — prod lives on a homelab VLAN and takes no runtime CDN
  dependencies. `prepareZXingModule({ overrides: { locateFile } })` points
  it at a self-hosted URL; Vite emits the binary as a hashed asset via a
  `?url` import from `zxing-wasm`. This is a hard task in the sequence,
  not a footnote.

### `@zxing/browser` + `@zxing/library` — runner-up

`@zxing/browser` 0.2.1 (2026-07-06), `@zxing/library` 0.23.0
(2026-04-29): maintenance has *revived* after a 2-year gap (0.1.5 was
2024-05), which is better than feared but a thin record. It is the old
Java-port lineage html5-qrcode already embeds — same decode core age,
JS-speed decoding, and its `BrowserMultiFormatReader` prefers to own the
video/`getUserMedia` (external-stream entry points exist but are the less
travelled path). Workable fallback if the wasm route hits a wall; not
preferred.

### `qr-scanner` (nimiq) — rejected

QR-only (1.4.2; worker-based, nice engine). **No EAN/UPC — fails the
product-scan requirement outright.**

### Recommendation

**Code the wrapper against the W3C `BarcodeDetector` API, implemented by
the `barcode-detector` ponyfill (zxing-wasm) on every platform, always —
no native-when-available branch.** Reasons: (a) Safari has no native path,
so on the household's devices the ponyfill *is* the scanner — a native
branch adds a second behavior only on desktop Chrome, where support is
flagged partial and decode behavior would silently differ from every
phone; (b) one engine everywhere means the fake-camera harness and the
real iPad exercise the same decoder; (c) if native ever ships in WebKit,
the upgrade is a one-line entry-point swap we make deliberately, with the
ponyfill demoted to actual-fallback — the code shape is already right.

---

## 3. Target architecture

### Ownership inversion

Today the library owns everything between `getUserMedia` and the decoded
string. After: **we own the stream and the loop; the dependency owns only
frame → barcodes.**

```
use-camera-stream (new hook, extracted from photo-camera's proven code)
  └─ owns getUserMedia({video:{facingMode:'environment'}}), release,
     visibilitychange release/reacquire, StrictMode-safe effect-scoped
     cancellation, late-resolve stop (the permission-prompt window)
camera-scanner.tsx (rewritten internals, same exported contract)
  ├─ <video muted playsInline autoPlay> absolutely filled, object-cover
  ├─ decode loop: every ~66–100 ms (≈10–15 fps, setInterval-gated, only
  │   while ready && visible): crop the centre decode box from the video
  │   to an offscreen canvas, await detector.detect(canvas)
  ├─ dedupe window, label overlay, brackets, Start/Stop/Close, error+retry
  └─ detector: BarcodeDetector ponyfill, one instance per formats set
```

### How the hard-won lessons carry over

- **Width-only video sizing (the portrait blow-up):** dies by
  construction. The video is CSS-box-owned exactly like photo-camera's
  (`absolute inset-0 w-full h-full object-cover` inside the existing
  clipped frame) — the stream's natural size can never drive layout
  again. The outer frame div and its classes are **unchanged**, so every
  consumer's flex-chain caps (capture's tablet clamps, the
  `flex-1 min-h-0` contract) keep working untouched. The `#scannerId`
  don't-constrain rule and the teardown `replaceChildren()` become
  obsolete and are deleted.
- **Decode region honesty (brackets = qrbox):** *strengthened*. Today we
  reverse-engineer the library's centred qrbox and draw brackets to
  match. After, the brackets and the decode crop are computed from the
  same `{w,h}` box by our own code — same `w = min(0.8×frameWidth, 300)`,
  `h = 0.6w` geometry, measured against the *frame* (we no longer need
  the library's container-width coupling). The crop maps CSS px →
  intrinsic video px through the object-cover transform (scale =
  max(frameW/videoW, frameH/videoH), centre-anchored) so the pixels
  decoded are exactly the pixels the brackets claim. Cropping before
  detect also keeps per-frame cost flat regardless of stream resolution
  — the same motivation as qrbox.
- **Lifecycle (the promise chain):** the chain existed to serialise a
  library whose async start/stop could not be trusted mid-flight. Our own
  stream teardown is synchronous (`track.stop()`), so the
  `desired`-ref/chain machinery collapses into photo-camera's
  effect-scoped `cancelled` flag pattern — already proven under
  StrictMode double-mount and the slow-permission-prompt race. Start/Stop
  buttons and error-retry become plain state (`wantCamera`) driving the
  hook, not enqueued thunks.
- **Convergence with photo-camera:** the hook is a *pure extraction* of
  photo-camera's acquire/release/visibility logic (photo-camera keeps its
  own `ready` gating and shutter). Both cameras then share one audited
  stream lifecycle — one place to fix the next iOS quirk. The
  "one camera at a time" guarantee (photo phase releases before scanner
  phases mount) is preserved because release stays synchronous in effect
  cleanup.
- **Dedupe/labels/error UI:** wrapper logic today, wrapper logic after —
  moved verbatim.

### The formats knob

`camera-scanner.tsx` exports its own type and the same default union:

```ts
export type ScannerFormat =
  | 'qr_code' | 'upc_a' | 'upc_e' | 'ean_13' | 'ean_8'
  | 'code_128' | 'code_39';
```

`tag-scanner.tsx` passes `['qr_code']`, `product-scanner.tsx` the six 1D
names — their `html5-qrcode` enum imports (the only ones outside the
wrapper) are deleted. Detector instances are memoised per formats set;
constructing one is cheap but the wasm module behind it is a singleton
prepared once.

### Wasm serving (no CDN, both pipelines)

`prepareZXingModule` with a `locateFile` override returning a
`?url`-imported asset from `zxing-wasm` (reader build, the one
`barcode-detector` uses). Vite hashes it into `dist/assets/`, so: served
by the same static nginx as the JS, cache-busted on upgrade, present in
the client tarball with **zero** `app.yml`/`build.yml` include changes
(the client tarball ships `dist/` wholesale), and identical in both build
pipelines (CI rule 7). Verified locally by grepping the built dist for a
`.wasm` asset and confirming zero requests leave the origin on scanner
start.

---

## 4. Migration sequence (SDD tasks)

Sized for the subagent pipeline; each task is independently verifiable
and the whole thing lands as **one PR** (single squash = single revert).

1. **Baseline pin.** Run the fake-camera harness against current master:
   drive a decode on `/capture` (product barcode), `/capture` place +
   `/scan` + `/move` (TLY tag), phone-portrait and tablet-landscape
   viewports. Record screenshots + the scanner frame's `offsetHeight` at
   each viewport + time-to-first-decode. These numbers are the acceptance
   bar, not a vibe.
2. **Dependency + wasm plumbing.** Add `barcode-detector` (+ its pinned
   `zxing-wasm`); create `client/src/lib/detector.ts`: `prepareZXingModule`
   with the self-hosted `?url` asset, per-formats detector factory.
   Verify: `npm run build`, wasm asset in dist, a node/vitest smoke test
   decoding a fixture PNG of a TLY QR and an EAN-13 through the factory.
   (This also pins that the *decoder* reads our actual codes before any
   UI moves.)
3. **Extract `use-camera-stream`.** Pure extraction from
   `photo-camera.tsx`; migrate photo-camera onto it in the same task —
   its existing vitest suite (`photo-camera.test.tsx`, 200 lines of
   StrictMode/visibility/fallback pins) must pass **unmodified**. That
   suite is the proof the extraction changed nothing.
4. **Rewrite `camera-scanner.tsx` internals** on the hook + detect loop
   per §3. Exported props unchanged except `formats?: ScannerFormat[]`;
   update `product-scanner.tsx`/`tag-scanner.tsx` format literals. Add a
   `camera-scanner.test.tsx` vitest suite in the photo-camera style
   (mock `use-camera-stream` + a stub detector): decode fires callback,
   dedupe window (refresh-while-visible semantics), stop/start, error →
   retry, unmount releases. Page-level suites need no changes (they mock
   the thin consumers) — run them anyway.
5. **Harness verification (the regression gate).** Same matrix as task 1,
   now decoding through zxing-wasm from the faked stream. Compare against
   the task-1 numbers: frame heights equal at every viewport (the
   flex-chain/clamp behavior is consumer-side and must not move),
   portrait-phone stream contained (the blow-up pin), decode succeeds on
   every surface, time-to-first-decode within ~2× of baseline. Read every
   PNG.
6. **Excise.** Remove `html5-qrcode` from `client/package.json`; grep
   proves zero imports remain; update the two CLAUDE.md mentions
   (tech-stack table row and Phase 2 bullet) to name the new stack; full
   gates (`tsc`, eslint, vitest, build).
7. **Real-device pass (operator-assisted).** iPhone Safari + the pending
   real-iPad camera check (tally-ux-waves backlog) in one session: scan a
   printed TLY tag and a retail barcode on `/capture`, `/scan`, `/move`.
   Safari is the primary platform and the harness runs Chromium — this
   step is not optional.

### Fake-camera harness compatibility

The harness patches `getUserMedia` via Playwright `addInitScript` to
return `canvas.captureStream(30)` driven by `setInterval` (not rAF —
rAF throttles in occluded tabs), fresh stream per call. It keeps working
**unchanged in mechanism**: after the migration our hook calls the same
patched `getUserMedia`, the fake stream feeds our `<video>`, and the
detect loop reads real frames from it. Two notes for task 5:

- The fixture code drawn on the canvas must sit **inside the centre
  decode box** (same constraint as today's qrbox — draw it centred and
  ≤60% of frame, and it lands in the crop at every viewport).
- The wasm must be servable by the harness's static `client/dist` server
  — self-hosting (§3) makes that automatic; the harness stays
  offline-capable.

### Regression pins (every scanner surface's driven checks)

- `/capture` identify: EAN-13 decode → product lookup fires; QR **not**
  decoded (format narrowing holds).
- `/capture` place: TLY QR decode → destination pinned; UPC not decoded.
- `/scan`: TLY QR → resolve + redirect; non-TLY QR → "not a tally tag"
  toast (extractTlyCode path).
- `/move` gather: item QR adds to carry; bin QR lands the load. /move
  distribute: item QR moves to pin. (Two TagScanner mounts, one at a
  time.)
- Continuously-visible code fires exactly once (2 s sliding dedupe).
- Stop → Start round-trip; Close mid-decode; deny-permission → error UI →
  Try again after granting.
- Tablet clamps: capture's `max-h-[clamp(…)]` wrappers bind; phone keeps
  full flex-1 height; frame `offsetHeight` equals task-1 baseline at
  every matrix viewport.
- StrictMode dev double-mount leaves exactly one live track (hook suite).
- photo-camera suite green, unmodified, on the shared hook.

---

## 5. Rollback

The wrapper boundary makes this one-commit revertible: the PR is squashed,
touches only `client/` (scanner folder, the new hook + detector lib,
package.json, CLAUDE.md prose), adds **no migration and no server
change**, and `git revert <squash>` restores html5-qrcode byte-for-byte —
the consumers' props never moved, so no caller is stranded mid-revert.
Deploy of a revert is an ordinary client deploy. The only non-code state
is the browser having cached a wasm asset, which is inert.

If trouble shows up only on real Safari after merge (the harness is
Chromium — this is the credible gap), revert first, diagnose second; the
old scanner is known-good and nothing else in the PR is load-bearing.

## 6. Bundle-size delta (estimate)

| | today (html5-qrcode) | after (barcode-detector + zxing-wasm) |
|---|---|---|
| JS in main bundle | ~375 KB min (~95 KB gz) — embedded zxing-js fork | ~15–25 KB min wrapper (~6 KB gz) |
| Wasm | — | ~1.04 MiB raw reader build, ~400–450 KB gz on the wire; **lazy** — fetched on first scanner start, immutable-cached thereafter |

Net: initial JS payload shrinks ~90 KB gz for every page load; scanner
surfaces pay a one-time ~430 KB deferred fetch from our own origin (LAN),
then cache. Decode speed: zxing-cpp/wasm is measurably faster per frame
than the JS port it replaces, at 10–15 fps polling the loop is cheaper
than today's. Acceptable trade for a LAN-served household app; the
harness timing check in task 5 keeps it honest.

## 7. Out of scope

- Torch/zoom/camera-picker features the old library offered and we never
  used.
- Native-BarcodeDetector progressive enhancement (deliberately rejected
  for now, §2 — revisit only if WebKit ships it).
- Any server or schema change (there is none).
