// @vitest-environment jsdom
/**
 * QR resolve error handling (#229).
 *
 * labels.service.js resolveCode() always answers 200 — an unknown code, a
 * malformed one, or one belonging to someone else's property all come back
 * as `{ exists: false }` (see labels.routes.js / labels.service.js:443-484).
 * It never 404s. Before this fix, qr-redirect.tsx ignored `exists` entirely
 * and would `navigate('/item/null')` on an unknown-but-well-formed code, and
 * collapsed every real failure (malformed code = 400, a 5xx) into the same
 * "not found" copy as a plain unknown code.
 *
 * This pins the real split: `exists: false` -> "doesn't exist" copy; an
 * actual HTTP failure -> "couldn't check" copy; both offer "Scan again"
 * (-> /scan) beside "Go to home".
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QrRedirect } from './qr-redirect';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderAt(code: string) {
  return render(
    <MemoryRouter initialEntries={[`/s/${code}`]}>
      <Routes>
        <Route path="/s/:code" element={<QrRedirect />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a well-formed but unknown code (exists: false, 200) renders "not found" copy with both buttons', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    jsonResponse({ success: true, data: { type: 'item', id: null, name: null, exists: false } })));

  renderAt('TLY-I-DEAD');

  await screen.findByText(/does not match any item/i);
  expect(navigateSpy).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Scan again' }).getAttribute('href')).toBe('/scan');
  expect(screen.getByRole('link', { name: 'Go to home' }).getAttribute('href')).toBe('/');
});

test('a real failure (400 malformed code) renders "couldn\'t check" copy, not "not found"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    jsonResponse({ success: false, message: 'Validation failed', errors: [] }, 400)));

  renderAt('garbage');

  await screen.findByText(/couldn.t check/i);
  expect(screen.queryByText(/does not match any item/i)).toBeNull();
  expect(screen.getByRole('link', { name: 'Scan again' }).getAttribute('href')).toBe('/scan');
  expect(screen.getByRole('link', { name: 'Go to home' }).getAttribute('href')).toBe('/');
});

test('a server error (500) also renders "couldn\'t check" copy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    jsonResponse({ success: false, message: 'Internal Server Error' }, 500)));

  renderAt('TLY-I-0001');

  await screen.findByText(/couldn.t check/i);
});

test('exists: true redirects straight to the entity, never rendering an error state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    jsonResponse({ success: true, data: { type: 'item', id: 42, name: 'Drill', exists: true } })));

  renderAt('TLY-I-002A');

  await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/item/42', { replace: true }));
});

test('a 401 redirects to login instead of showing either error state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    jsonResponse({ success: false, message: 'Unauthorized' }, 401)));

  renderAt('TLY-I-0001');

  await waitFor(() =>
    expect(navigateSpy).toHaveBeenCalledWith('/login?redirect=/s/TLY-I-0001', { replace: true }));
});
