// @vitest-environment jsdom
/**
 * #284 — /recycle-bin was the only page in its cluster with no TitleBar and
 * no real <h1>: `<h2>Recycle Bin</h2>` versus matches.tsx/print-queue.tsx's
 * `<h1><TitleBar>…</TitleBar></h1>`. The page's only <h1> was the sidebar's
 * "Tally".
 */
import { render, screen } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { RecycleBin } from './recycle-bin';

vi.mock('@/components/recycle-bin/recycle-bin-list', () => ({
  RecycleBinList: () => <div data-testid="recycle-bin-list" />,
}));

test('the page has a real <h1>, styled like its sibling batch surfaces', () => {
  render(<RecycleBin />);

  const heading = screen.getByRole('heading', { level: 1, name: 'Recycle Bin' });
  expect(heading).toBeTruthy();
});
