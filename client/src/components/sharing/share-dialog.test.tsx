// @vitest-environment jsdom
/**
 * #282, first finding: `grep -rn "share/" client/src` returned only the route
 * definition — there was no anchor to a share view anywhere in the app, so the
 * only way to check what you had just published was to copy the URL and paste
 * it into a new tab by hand. These tests pin the anchor (and that copy, the
 * affordance that already worked, is still there beside it).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ShareDialog } from './share-dialog';

const LINK = {
  id: 1,
  token: 'tok-1',
  entityType: 'container',
  entityId: 1,
  url: 'https://tally.example/share/tok-1',
  expiresAt: '2026-09-05T00:00:00Z',
  createdAt: '2026-08-29T00:00:00Z',
};

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

const createMutate = vi.fn();

vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: () => ({ data: [LINK], isLoading: false }),
  useShareDisclosure: () => ({ data: ITEM_CATEGORIES }),
  useCreateShareLink: () => ({ mutate: createMutate, isPending: false }),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => createMutate.mockClear());

test('an existing share link is a real anchor that opens in a new tab', () => {
  render(
    <ShareDialog
      entityType="container"
      entityId={1}
      entityName="Bin A"
      isOpen
      onOpenChange={() => {}}
    />,
  );

  const anchor = screen.getByRole('link', { name: LINK.url });
  expect(anchor.getAttribute('href')).toBe(LINK.url);
  expect(anchor.getAttribute('target')).toBe('_blank');
  // Without noopener the opened tab can reach back through window.opener.
  expect(anchor.getAttribute('rel')).toContain('noopener');
  expect(anchor.getAttribute('rel')).toContain('noreferrer');
});

test('copy is still offered alongside the anchor, not replaced by it', () => {
  render(
    <ShareDialog
      entityType="container"
      entityId={1}
      entityName="Bin A"
      isOpen
      onOpenChange={() => {}}
    />,
  );

  expect(screen.getByTitle('Copy link')).toBeTruthy();
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
