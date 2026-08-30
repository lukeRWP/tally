import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Desktop keyboard navigation.
 *
 * A pointer is not the only thing a desk has that a phone does not — it also
 * has a keyboard your hands are already on. Without this, moving through a
 * hundred bins is a hundred round trips to the mouse.
 *
 * Deliberately narrow. These are the four keys people already expect from a
 * list (`/` to search, j/k to move, Enter to open, Escape to back out); a
 * larger set would need teaching, and nothing here teaches it. A surface
 * whose rows carry real decisions can bind its own keys on top via onAction
 * (#269) — the hook stays the single keydown listener with the single set of
 * guards, and the surface owns what the extra keys mean.
 *
 * Keeping the cursor VISIBLE (#235): the hook itself never knows which row is
 * highlighted — every surface owns its own cursor state — so scrolling is a
 * sibling hook plus a markup convention, one shared mechanism for all six
 * wired surfaces:
 *
 *   1. each row (or its wrapper) carries `data-nav-id={id}`, the same id/key
 *      the surface's cursor state tracks;
 *   2. the surface calls `useNavScrollIntoView(highlightedId)` beside its
 *      `useKeyboardNav` call.
 *
 * On every cursor MOVE the row scrolls into view with `block: 'nearest'`,
 * which respects whatever scroll container the row lives in (root-layout's
 * <main>, the destination picker's own overflow list). A "move" is leaving a
 * real previous cursor — see useNavScrollIntoView for the exact rule and why
 * a mount-skip was not enough.
 *
 * Surviving the round trip (#270): a cursor held in `useState` dies on every
 * Back, because Back remounts the surface while use-scroll-restoration.ts
 * faithfully restores the pixels — so the list came back exactly where you
 * left it with nothing highlighted, and the next `j` re-seeded at row 1,
 * hundreds of pixels off-screen, scrolling nothing (the baseline rule above
 * correctly refuses to scroll a first landing). The cursor therefore lives in
 * the URL — see useNavCursorParam.
 */
export interface KeyboardNavOptions {
  /** Move the selection. Not called when nothing is selectable. */
  onMove?: (delta: 1 | -1) => void;
  /**
   * Open whatever is selected. Return true when something was actually
   * opened: the hook preventDefaults the Enter keypress only then (#235), so
   * a Tab-focused control elsewhere cannot double-act on the same press —
   * while an idle ring (nothing highlighted) leaves Enter to whatever is
   * focused, exactly as before.
   */
  onOpen?: () => boolean | void;
  /**
   * Back out: clear the selection, close the panel.
   *
   * Runs only when focus is NOT in a field (#271). Escape has two jobs on a
   * ringed surface — leave the field, leave the selection — and firing both
   * on one press meant `/search`'s restored `?sel` cursor was destroyed by
   * the only gesture that could blur its autoFocused input. They are now
   * sequential: first Escape leaves the field, second Escape leaves the
   * selection.
   */
  onEscape?: () => void;
  /** Focus the page's search field. */
  onSearch?: () => void;
  /**
   * Tab moved focus onto a row — adopt it as the cursor (#279).
   *
   * Called with that row's `data-nav-id` (the nearest ancestor carrying one),
   * so a Tab user and the ring share ONE cursor instead of drawing two and
   * letting Enter arbitrate between them: the ring on row 20 while the focus
   * outline sat on row 1, and Enter opening row 20. Fusing beats refereeing —
   * Tab now MOVES the ring. Surfaces should ignore an id they don't recognise.
   */
  onFocusRow?: (navId: string) => void;
  /**
   * A key the SURFACE binds, for the decisions its rows actually carry (#269).
   *
   * The four keys above move a cursor; they never *do* anything. That was
   * fine for a list whose rows only open — and useless on /matches, where the
   * ring reached a row, opened its candidate panel, and then handed you back
   * to the mouse for the only thing the page exists to do. Rather than let
   * such a surface add its own window listener (which would have to re-derive
   * every guard below, and would get one of them wrong), it hands the key
   * here and gets the guards for free: not while typing, not with a modifier
   * held, not from a `data-nav-ignore` control, and not on auto-repeat.
   *
   * `e.repeat` is dropped because a held key is not a gesture a mouse has:
   * every action a surface is likely to bind here is a one-way decision, and
   * leaning on the key must not walk one down a backlog. For the same reason
   * the key must arrive ALONE — see ACTION_BURST_MS, which is what keeps a
   * barcode scanner from resolving a worklist.
   *
   * No return value: the fire is deferred by ACTION_BURST_MS, so nothing the
   * surface says can still decide `preventDefault` for an event that is long
   * over. The hook prevents the default of any key it arms instead — arming
   * IS taking responsibility for the keypress — which is what stops a bound
   * letter from reaching Firefox's type-ahead find or a bound Space from
   * scrolling the page under the panel.
   */
  onAction?: (key: string) => void;
  /** Off in touch chrome, where there is no keyboard to serve. */
  enabled?: boolean;
}

/**
 * A ring cursor parked in the URL, so it survives a detail round-trip (#270).
 *
 * The model is search.tsx's `?sel=`, the one surface that already got this
 * right: look, Enter, read, Back, and the highlight is still on the row you
 * left. State cannot do it — Back remounts the surface — and it is the URL
 * rather than a sessionStorage cache precisely because the browser's history
 * entry is already the thing POP restores, so the cursor rides back on the
 * same navigation that restores the scroll offset, with no second POP/PUSH
 * rule to keep in sync.
 *
 * How this composes with use-scroll-restoration.ts, whose semantics are
 * hard-won and untouched here:
 *
 *   POP     the restored history entry carries the params, so the cursor is
 *           already in the URL on the mount commit — the same navigation
 *           whose rAF restores `scrollTop`. Nothing races: the cursor's first
 *           non-null value per mount is useNavScrollIntoView's silent
 *           BASELINE, so it never scrolls and never fights the restore.
 *   PUSH    a new pathname carries no cursor param, and scroll resets to top.
 *           Both start clean, for the same reason and at the same moment.
 *   REPLACE every write here is `{ replace: true }` on the SAME pathname,
 *           which use-scroll-restoration.ts provably ignores (it is keyed on
 *           pathname; Home's debounced search REPLACEs on every keystroke and
 *           must not reset scroll). So walking the ring with j/k never
 *           disturbs the scroll cache, and never adds a history entry —
 *           Back still leaves the page rather than rewinding the cursor.
 *
 * Writes are skipped when the value is unchanged, so a focus landing on the
 * already-current row costs no navigation at all.
 *
 * ONE WRITER PER PARAM, and never two in the same effect flush. React
 * Router's functional `setSearchParams` hands the updater the params from
 * ITS OWN render's closure, not the live URL — so two writers firing in one
 * commit both merge from the same stale snapshot and the second silently
 * undoes the first. A surface that must clear this cursor as part of another
 * param change has to fold that clear into that single write (see home.tsx's
 * URL-sync effect), not schedule a second one beside it.
 */
export function useNavCursorParam(param: string): {
  cursor: string | null;
  setCursor: (value: string | null) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(param);
  const cursor = raw == null || raw === '' ? null : raw;

  // Both of these are read through refs so `setCursor` can keep a genuinely
  // stable identity — surfaces put it in the deps of their move handlers, and
  // `setSearchParams` is itself re-created whenever `location.search` changes,
  // i.e. on every j. Depending on it directly re-ran every effect downstream
  // of the ring once per keypress and cost a redundant history.replace.
  const paramsRef = useRef(searchParams);
  paramsRef.current = searchParams;
  const setParamsRef = useRef(setSearchParams);
  setParamsRef.current = setSearchParams;

  const setCursor = useCallback((value: string | null) => {
    if ((paramsRef.current.get(param) ?? null) === value) return;
    setParamsRef.current((prev) => {
      const next = new URLSearchParams(prev);
      // MERGE, never rebuild — the surface's own params (q, status, tags…)
      // share this URL and must survive a cursor move.
      if (value == null) next.delete(param); else next.set(param, value);
      return next;
    }, { replace: true });
  }, [param]);

  return { cursor, setCursor };
}

/**
 * Scrolls the row marked `data-nav-id={id}` into view on a cursor MOVE.
 *
 * The shared half of the ring's scroll mechanism (see the header comment) —
 * pass the surface's own cursor state (id, key, or null). `block: 'nearest'`
 * means a row already on screen moves nothing at all, so a cursor handed off
 * by a click (matches.tsx's selection sync) is a no-op rather than a jump.
 *
 * The rule (#235 round 2): scroll only when `prev !== null && id !== prev` —
 * leaving one real cursor for another. A plain skip-the-first-effect-run was
 * not enough: matches.tsx seeds its cursor from `?sel=` one effect AFTER
 * mount (null on the mount commit, the id right after), so the skip was
 * spent on null and the seed's arrival counted as a "move" — scrolling on a
 * fresh load and racing use-scroll-restoration.ts's rAF restore. Under this
 * rule the FIRST non-null id per mount, however many commits late, is a
 * silent baseline; arrival stays scroll restoration's moment. It also means
 * a cleared-then-reset cursor (Escape, then j) re-baselines on its first
 * landing instead of jumping.
 */
export function useNavScrollIntoView(id: string | number | null | undefined) {
  /** The last cursor observed; null doubles as "no baseline yet". */
  const prevRef = useRef<string | number | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = id ?? null;
    if (id == null || prev == null || id === prev) return;
    const el = document.querySelector(`[data-nav-id="${CSS.escape(String(id))}"]`);
    // Optional call: jsdom implements no scrollIntoView, and the existing
    // keyboard suites run every one of these moves without mocking it.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [id]);
}

/**
 * True when the user is typing and a bare letter must stay a letter.
 *
 * Without this, `j` inside the search box moves the list selection and never
 * reaches the input — the single most common way a shortcut layer like this
 * becomes actively hostile.
 */
/**
 * `target.closest(selector)`, safe for an arbitrary event target.
 *
 * A keydown/focusin target is not guaranteed to be an Element (window and the
 * document both fire here), so the capability is tested rather than the type
 * asserted — the same lesson isTyping below learned the hard way.
 */
function closestMatch(target: EventTarget | null, selector: string): Element | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(selector);
}

/**
 * A row's SECONDARY control — one the ring must keep its hands off.
 *
 * Almost every ringed row is a single button, so fusing focus into the ring
 * (see onFocusRow) and letting the ring own Enter agree perfectly. The areas
 * tree is the exception: its rows carry an expand chevron beside the name.
 * Focusing that chevron must not move the ring, and Enter on it must expand
 * the bin rather than open it — mark such controls `data-nav-ignore`.
 */
const NAV_IGNORE = '[data-nav-ignore]';

/**
 * How much silence has to surround an action key for it to count as a person.
 *
 * `isTyping` below is the only thing standing between a bare-key binding and
 * the rest of the world, and it defends exactly one case: a text field has
 * focus. Everywhere a scanner reaches tally today that is enough, because a
 * scan lands in a field (/move's typed-code input) or in the camera. But
 * /matches has NO fields at all — so a USB barcode scanner firing while that
 * page is open at a desk types its payload straight into the bindings, with
 * focus resting on a button or on <body>. Twelve digits, twelve resolves,
 * each one an irreversible link to the wrong product, silently. The ring's
 * older keys (j/k/Enter) were harmless under the same treatment; the action
 * keys are the first ones where this costs data, so the guard arrives with
 * them.
 *
 * There is no structural signal to use instead. A HID scanner IS a keyboard:
 * its events are trusted, carry no device identity, and are indistinguishable
 * from a person's except in one respect — cadence. It types a whole payload
 * in a burst, 1-20ms between characters (which is why a scan feels
 * instantaneous), and even the inter-character delays those devices expose
 * top out around 30ms. A human pressing a decision key cannot come close:
 * ~100ms is the floor for two DELIBERATE presses, and a key that means "use
 * candidate 2 of this match" is far slower again. (The alternative that is
 * structural rather than heuristic — moving the actions onto modifier chords
 * a scanner cannot emit — costs exactly the ergonomics these bindings exist
 * to buy, so it is the wrong trade here.)
 *
 * So an action key fires only when it is ISOLATED: no other keydown within
 * this window on EITHER side of it. Rejecting keys that arrive too soon after
 * the previous one — the obvious form of this guard — still lets the FIRST
 * character of a burst through, because nothing precedes it, and on a
 * three-candidate row a leading 1, 2 or 3 is a live decision. Waiting the
 * window out before firing is what closes that: silence afterwards is the one
 * thing a burst cannot fake.
 *
 * 60ms: triple the cadence of the scanners this has to stop, comfortably
 * under the ~100ms floor of a deliberate second press, and under the ~100ms
 * at which added latency becomes perceptible at all — so the key still feels
 * instant, and what it fires is a network round trip anyway.
 */
const ACTION_BURST_MS = 60;

export function isTyping(target: EventTarget | null): boolean {
  // Partial<HTMLElement>, not HTMLElement: a keydown target is not guaranteed
  // to be an element at all. Casting to HTMLElement told TypeScript every field
  // was present, so returning `el.isContentEditable` — undefined on anything
  // that is not one — type-checked as boolean and was not.
  const el = target as Partial<HTMLElement> | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || el.isContentEditable === true;
}

export function useKeyboardNav({
  onMove, onOpen, onEscape, onSearch, onFocusRow, onAction, enabled = true,
}: KeyboardNavOptions) {
  /**
   * The armed-but-not-yet-fired action key, and when the last key arrived.
   *
   * Refs, and the timer is deliberately NOT cleared by the keydown effect's
   * cleanup: `onAction` is a fresh closure on every render of the surface, so
   * that effect re-subscribes constantly, and tearing the pending action down
   * with it would silently swallow a keypress any time a poll re-rendered
   * inside the 60ms window. Only unmount cancels. Reading the handler back
   * through a ref at fire time is also what keeps the deferral honest: the
   * action runs against the surface's CURRENT state, not the render that
   * happened to be mounted when the key went down.
   */
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const armedRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeyAtRef = useRef(0);
  useEffect(() => () => { if (armedRef.current) clearTimeout(armedRef.current); }, []);

  /**
   * Tab (or a click) landing on a row hands the ring its cursor (#279).
   *
   * `focusin` rather than `focus` because it bubbles — one window listener
   * covers every row without per-row wiring — and the nearest `data-nav-id`
   * ancestor is looked up rather than the focused node itself, since the
   * focusable thing is the row's inner button while the marker sits on the
   * wrapper. Adopting a cursor the surface already holds costs nothing:
   * useNavScrollIntoView uses `block: 'nearest'`, and the browser has just
   * scrolled the newly focused row into view anyway.
   */
  useEffect(() => {
    if (!enabled || !onFocusRow) return;
    const onFocusIn = (e: FocusEvent) => {
      if (closestMatch(e.target, NAV_IGNORE)) return;
      const navId = closestMatch(e.target, '[data-nav-id]')?.getAttribute('data-nav-id');
      if (navId) onFocusRow(navId);
    };
    window.addEventListener('focusin', onFocusIn);
    return () => window.removeEventListener('focusin', onFocusIn);
  }, [enabled, onFocusRow]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Burst bookkeeping, before any of the early returns so that EVERY key
      // the window sees counts — a barcode is mostly characters this hook
      // does not bind, and they are exactly what proves the digits around
      // them came from a machine. Any keydown at all also disarms a pending
      // action: a second key inside the window means either a burst or a
      // changed mind, and neither should resolve a match.
      if (armedRef.current) { clearTimeout(armedRef.current); armedRef.current = null; }
      const now = Date.now();
      const sinceLastKey = now - lastKeyAtRef.current;
      lastKeyAtRef.current = now;

      // Escape is the exception: it must work FROM a field, because getting out
      // of one is most of what it is for. But that is ALL it does from a field
      // (#271) — blurring and clearing the selection on the same press meant
      // the only gesture that could leave `/search`'s autoFocused input also
      // threw away the cursor Back had just restored. Sequential instead:
      // first Escape leaves the field, second Escape leaves the selection.
      if (e.key === 'Escape') {
        if (isTyping(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
        onEscape?.();
        return;
      }

      if (isTyping(e.target)) return;
      // Never swallow a browser or OS shortcut.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case '/':
          if (!onSearch) return;
          e.preventDefault();      // or the '/' lands in the field it just focused
          onSearch();
          break;
        case 'j':
        case 'ArrowDown':
          if (!onMove) return;
          e.preventDefault();      // stop the page scrolling under the selection
          onMove(1);
          break;
        case 'k':
        case 'ArrowUp':
          if (!onMove) return;
          e.preventDefault();
          onMove(-1);
          break;
        case 'Enter':
          if (!onOpen) return;
          // A row's secondary control keeps its own Enter (#279) — expanding
          // a tree row must not open the bin. Everywhere else a ringed row is
          // one button, so the ring and the focus outline mark the same thing
          // and the ring may speak for it.
          if (closestMatch(e.target, NAV_IGNORE)) return;
          // The ring owns Enter only when it actually opened something — a
          // Tab-focused row or button must not fire on the same press (#235).
          // With nothing highlighted, onOpen reports false and the keypress
          // stays the browser's, so focused controls keep working.
          if (onOpen() === true) e.preventDefault();
          break;
        default: {
          // Everything the ring itself does not claim is offered to the
          // surface (#269) — see onAction for the guards this inherits.
          if (!onAction || e.repeat) return;
          if (closestMatch(e.target, NAV_IGNORE)) return;
          // Mid-burst: something was typed less than a window ago, so this
          // key has a machine behind it. (The first key of a burst passes
          // here and is caught on the other side instead — it gets disarmed
          // by the character that follows it.)
          if (sinceLastKey < ACTION_BURST_MS) return;
          const key = e.key;
          e.preventDefault();
          armedRef.current = setTimeout(() => {
            armedRef.current = null;
            onActionRef.current?.(key);
          }, ACTION_BURST_MS);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onMove, onOpen, onEscape, onSearch, onAction, enabled]);
}
