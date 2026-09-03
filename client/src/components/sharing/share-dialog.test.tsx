// @vitest-environment jsdom
/**
 * #282, first finding: `grep -rn "share/" client/src` returned only the route
 * definition — there was no anchor to a share view anywhere in the app, so the
 * only way to check what you had just published was to copy the URL and paste
 * it into a new tab by hand. These tests pin the anchor (and that copy, the
 * affordance that already worked, is still there beside it).
 *
 * Since #349 that anchor exists in exactly one place: the panel for the link
 * you just generated. The server keeps a digest of the token, so the list of
 * existing links has no URL to offer — only who made each one, when, and a
 * way to revoke it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ShareDialog } from './share-dialog';

const LINK = {
  id: 1,
  entityType: 'container',
  entityId: 1,
  propertyId: 3,
  createdBy: 8,
  createdByName: 'Sam',
  expiresAt: '2026-09-05T00:00:00Z',
  createdAt: '2026-08-29T00:00:00Z',
};

const NEW_URL = 'https://tally.example/share/tok-new';

/**
 * The catalogue exactly as GET /api/sharing/_x_/disclosure serves it for an
 * item (server/src/modules/sharing/sharing.disclosure.js). The server side
 * proves each of these categories really strips something from the payload;
 * these tests prove the dialog states them and defaults every one to on.
 */
const ITEM_CATEGORIES = [
  { key: 'contents', label: 'What is in it', detail: 'Names, descriptions…', optional: false, defaultValue: true },
  { key: 'location', label: 'Where it is kept', detail: 'The property, room and container names…', optional: true, defaultValue: true },
  { key: 'purchasePrice', label: 'What you paid', detail: 'The purchase price recorded for this item.', optional: true, defaultValue: true },
  { key: 'files', label: 'Photos and receipts', detail: 'Every file attached to this item…', optional: true, defaultValue: true },
];

/**
 * Resolves like the real hook: the create response is the LINK (`url` and
 * all), not the `{ link }` envelope the route wraps it in. The dialog once
 * read `.url` off the envelope and never showed the new link; a mock that
 * handed back the envelope would keep that bug invisible.
 */
type CreateVars = { entityType: string; entityId: number; expiresInDays: number; disclosure?: Record<string, boolean> };
const createMutate = vi.fn((_vars: CreateVars, opts?: { onSuccess?: (link: typeof LINK & { url: string }) => void }) => {
  opts?.onSuccess?.({ ...LINK, id: 2, createdBy: 42, createdByName: 'Me', url: NEW_URL });
});

/**
 * What the server currently serves. A test may swap this to model a catalogue
 * whose defaults differ, which is the whole point of the dialog reading them
 * rather than assuming all-on.
 */
let served = ITEM_CATEGORIES;

vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: () => ({ data: [LINK], isLoading: false }),
  useShareDisclosure: () => ({ data: served }),
  useCreateShareLink: () => ({ mutate: createMutate, isPending: false }),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  createMutate.mockClear();
  served = ITEM_CATEGORIES;
});

function openContainer() {
  render(
    <ShareDialog
      entityType="container"
      entityId={1}
      entityName="Bin A"
      isOpen
      onOpenChange={() => {}}
    />,
  );
}

test('a freshly generated link is a real anchor that opens in a new tab, with copy beside it', () => {
  openContainer();
  act(() => { fireEvent.click(screen.getByRole('button', { name: /generate link/i })); });

  const anchor = screen.getByRole('link', { name: NEW_URL });
  expect(anchor.getAttribute('href')).toBe(NEW_URL);
  expect(anchor.getAttribute('target')).toBe('_blank');
  // Without noopener the opened tab can reach back through window.opener.
  expect(anchor.getAttribute('rel')).toContain('noopener');
  expect(anchor.getAttribute('rel')).toContain('noreferrer');
  expect(screen.getByTitle('Copy link')).toBeTruthy();
  // …and the sharer is told this is the only time they will see it.
  expect(screen.getByText(/shown only once/i)).toBeTruthy();
});

test('existing links show who made them and when they die — no URL, no copy, only revoke', () => {
  openContainer();

  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByTitle('Copy link')).toBeNull();
  expect(screen.getByText(/by Sam/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /revoke the link created/i })).toBeTruthy();
});

// ── What the recipient will see (#298) ──────────────────────────────────────

function open() {
  render(
    <ShareDialog entityType="item" entityId={1} entityName="Drill" isOpen onOpenChange={() => {}} />,
  );
}

test('the dialog names every category the payload can carry, from the server catalogue', () => {
  open();

  // Always-shared rows are stated even though there is nothing to decide —
  // "anyone can view without signing in" never said WHAT they can view.
  expect(screen.getByText('What is in it')).toBeTruthy();

  for (const c of ITEM_CATEGORIES.filter((x) => x.optional)) {
    expect(screen.getByRole('checkbox', { name: new RegExp(c.label) })).toBeTruthy();
  }
  // …and only what applies: this is an item share, so no property address row.
  expect(screen.queryByText('The property address')).toBeNull();
});

test('every category starts on, so an untouched dialog publishes what it always did', () => {
  open();

  for (const box of screen.getAllByRole('checkbox')) {
    expect((box as HTMLInputElement).checked).toBe(true);
  }

  fireEvent.click(screen.getByRole('button', { name: /generate link/i }));
  expect(createMutate).toHaveBeenCalledTimes(1);
  // No `disclosure` at all — the server then stores NULL, which is the row a
  // pre-#298 link has. This PR must not change what any share publishes.
  expect(createMutate.mock.calls[0][0]).toEqual({
    entityType: 'item',
    entityId: 1,
    expiresInDays: 7,
    disclosure: undefined,
  });
});

test('turning one category off sends the whole choice, not just the box that moved', () => {
  open();

  fireEvent.click(screen.getByRole('checkbox', { name: /What you paid/ }));
  expect(
    (screen.getByRole('checkbox', { name: /What you paid/ }) as HTMLInputElement).checked,
  ).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /generate link/i }));
  expect(createMutate.mock.calls[0][0].disclosure).toEqual({
    location: true,
    purchasePrice: false,
    files: true,
  });
});

// ── The tick comes from the server, not from here (#298) ────────────────────
// Whether a category should start on is the server's declared policy
// (sharing.disclosure.js `defaultOn`, served as `defaultValue`). If the dialog
// assumed all-on instead, changing a default would silently show the sharer a
// ticked box for something the server was about to withhold — or, far worse, a
// ticked box that no longer matched what got published.

test('a category the server defaults to off starts unticked, and is sent as off', () => {
  served = ITEM_CATEGORIES.map((c) =>
    c.key === 'purchasePrice' ? { ...c, defaultValue: false } : c,
  );
  open();

  expect(
    (screen.getByRole('checkbox', { name: /What you paid/ }) as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByRole('checkbox', { name: /Photos and receipts/ }) as HTMLInputElement).checked,
  ).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: /generate link/i }));
  expect(createMutate.mock.calls[0][0].disclosure).toEqual({
    location: true,
    purchasePrice: false,
    files: true,
  });
});

test('the sharer can still override a default-off category back on', () => {
  served = ITEM_CATEGORIES.map((c) =>
    c.key === 'purchasePrice' ? { ...c, defaultValue: false } : c,
  );
  open();

  fireEvent.click(screen.getByRole('checkbox', { name: /What you paid/ }));
  expect(
    (screen.getByRole('checkbox', { name: /What you paid/ }) as HTMLInputElement).checked,
  ).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: /generate link/i }));
  // Everything is on again, so this is the all-on link — no `disclosure` at all.
  expect(createMutate.mock.calls[0][0].disclosure).toBeUndefined();
});
