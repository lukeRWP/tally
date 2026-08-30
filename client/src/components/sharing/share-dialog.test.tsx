// @vitest-environment jsdom
/**
 * #282, first finding: `grep -rn "share/" client/src` returned only the route
 * definition — there was no anchor to a share view anywhere in the app, so the
 * only way to check what you had just published was to copy the URL and paste
 * it into a new tab by hand. These tests pin the anchor (and that copy, the
 * affordance that already worked, is still there beside it).
 */
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
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

vi.mock('@/hooks/use-sharing', () => ({
  useMyShareLinks: () => ({ data: [LINK], isLoading: false }),
  useCreateShareLink: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

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
