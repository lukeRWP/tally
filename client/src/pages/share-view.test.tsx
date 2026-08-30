// @vitest-environment jsdom
/**
 * The public share page (#282) — the one surface strangers see.
 *
 * Three things it never used to say: who shared it, when the link dies, and
 * what Tally even is. The first two now ride on `data.share` from the public
 * route (sharing.routes.js), which is optional by design — an older server, or
 * a link whose creator row is gone, sends less. These tests pin BOTH halves of
 * that: present when the payload carries it, silently absent when it doesn't,
 * and never fabricated.
 *
 * They also pin the header's one action: a stranger with no session must not be
 * offered a sign-in that lands on a tenant they have no account in.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ShareView } from './share-view';

let sessionUser: { id: number; displayName: string } | null = null;
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: sessionUser, isLoading: false }),
}));

const CONTAINER_ENTITY = {
  type: 'container',
  container: {
    id: 1,
    name: 'Bin A',
    type: 'tote',
    description: 'Hand tools, second shelf',
    breadcrumb: [
      { id: 1, name: 'Rockwood', type: 'property' },
      { id: 1, name: 'Garage', type: 'area' },
    ],
  },
  nestedContainers: [],
  items: [{ id: 1, name: 'Cordless Drill', condition: 'good', quantity: 1 }],
};

const ITEM_ENTITY = {
  type: 'item',
  item: {
    id: 1,
    name: 'Cordless Drill',
    condition: 'good',
    quantity: 1,
    purchasePrice: 189.99,
    currentValue: 120,
    breadcrumb: [],
  },
  files: [],
  dates: [],
  conditionSnapshots: [],
};

/** Answer the public share fetch with whatever `data` the test wants. */
function mockShare(data: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      json: async () => (ok ? { success: true, data } : { success: false, message: 'This link has expired or is invalid.' }),
    })),
  );
}

function renderShare() {
  return render(
    <MemoryRouter initialEntries={['/share/tok-1']}>
      <Routes>
        <Route path="/share/:token" element={<ShareView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionUser = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('names the sharer and the expiry date when the payload carries them', async () => {
  mockShare({
    entity: CONTAINER_ENTITY,
    share: { entityType: 'container', sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' },
  });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).toMatch(/Shared by/i);
  expect(provenance.textContent).toMatch(/Luke Turner/);
  // Rendered through toLocaleDateString, so match the parts rather than a format.
  expect(provenance.textContent).toMatch(/Expires/i);
  expect(provenance.textContent).toMatch(/2026/);
  expect(provenance.textContent).toMatch(/Sep/i);
});

test('explains what Tally is and how much of the inventory this link reaches', async () => {
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).toMatch(/home-inventory app/i);
  expect(provenance.textContent).toMatch(/one container/i);
  expect(provenance.textContent).toMatch(/read only/i);
});

test('the scope sentence follows the shared entity — an item share says "one item"', async () => {
  mockShare({ entity: ITEM_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).toMatch(/one item from/i);
});

test('omits the sharer and expiry lines rather than faking them when the payload lacks them', async () => {
  mockShare({ entity: CONTAINER_ENTITY });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).toMatch(/Shared with you/i);
  expect(provenance.textContent).not.toMatch(/Shared by/i);
  expect(provenance.textContent).not.toMatch(/Expires/i);
  // The framing that does not depend on the server still shows.
  expect(provenance.textContent).toMatch(/home-inventory app/i);
});

test('a null sharer name (creator row gone) drops only that line, keeping the expiry', async () => {
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: null, expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).not.toMatch(/Shared by/i);
  expect(provenance.textContent).toMatch(/Expires/i);
});

test('an unparseable expiry is dropped, not printed as "Invalid Date"', async () => {
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: 'not-a-date' } });
  renderShare();

  const provenance = await screen.findByTestId('share-provenance');
  expect(provenance.textContent).toMatch(/Shared by/i);
  expect(provenance.textContent).not.toMatch(/Expires/i);
  expect(provenance.textContent).not.toMatch(/Invalid Date/i);
});

test('offers a stranger no sign-in — the tenant has no account for them', async () => {
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  await screen.findByTestId('share-provenance');
  expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

test('offers a signed-in viewer a way back into the app', async () => {
  sessionUser = { id: 1, displayName: 'Luke Turner' };
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  await screen.findByTestId('share-provenance');
  const link = screen.getByRole('link', { name: /open tally/i });
  expect(link.getAttribute('href')).toBe('/');
});

test('the expired case explains the expiry instead of pointing at a dead sign-in', async () => {
  mockShare(null, false, 404);
  renderShare();

  await waitFor(() => expect(screen.getByText(/Link unavailable/i)).toBeTruthy());
  expect(screen.getByText(/expired or is invalid/i)).toBeTruthy();
  expect(screen.getByText(/nothing to sign in to here/i)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
});

test('renders the shared contents themselves as static rows, not fake buttons', async () => {
  mockShare({ entity: CONTAINER_ENTITY, share: { sharedByName: 'Luke Turner', expiresAt: '2026-09-05T00:00:00Z' } });
  renderShare();

  await screen.findByTestId('share-provenance');
  expect(screen.getByText('Bin A')).toBeTruthy();
  expect(screen.getByText('Cordless Drill')).toBeTruthy();
  // A read-only page must not offer rows that look pressable and go nowhere.
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
