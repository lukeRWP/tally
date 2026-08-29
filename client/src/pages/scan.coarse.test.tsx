// @vitest-environment jsdom
/**
 * /scan follows the coarse-pointer fork (task-1, #219).
 *
 * scan.tsx used to fork on `atDesk` alone: sidebar chrome got a typed-code
 * field with an autofocus (a USB reader is a keyboard, so it lands there),
 * while everything else got the camera scanner first. That treated a
 * landscape iPad — sidebar chrome, but a finger for a pointer — the same as
 * a mouse-and-keyboard desk: the autofocus popped the on-screen keyboard on
 * open, on top of a screen with no mouse to dismiss it with, for a device
 * that plausibly has a rear camera to hold a label up to.
 *
 * put-down.tsx and capture.tsx already made this fork once each
 * (`showScanner` / `showForm`, keyed on `useLayoutMode() === 'sidebar'` AND
 * `useCoarsePointer()`). This pins the same shape on scan.tsx: a coarse
 * desk renders the scanner-first layout (typed field below, no autofocus)
 * like a phone; a fine-pointer desk keeps today's typed-first layout and
 * its autofocus; a phone is unchanged.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { test, expect, vi, beforeEach } from 'vitest';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';
import { Scan } from './scan';

vi.mock('@/hooks/use-layout-mode', () => ({ useLayoutMode: vi.fn() }));
vi.mock('@/hooks/use-coarse-pointer', () => ({ useCoarsePointer: vi.fn() }));
vi.mock('@/components/scanner/tag-scanner', () => ({
  TagScanner: () => <div data-testid="tag-scanner">tag scanner</div>,
}));

function setMode(layout: 'sidebar' | 'touch', coarse: boolean) {
  vi.mocked(useLayoutMode).mockReturnValue(layout);
  vi.mocked(useCoarsePointer).mockReturnValue(coarse);
}

function renderScan() {
  return render(
    <MemoryRouter>
      <Scan />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useLayoutMode).mockReset();
  vi.mocked(useCoarsePointer).mockReset();
});

test('sidebar+coarse (landscape iPad) renders the camera scanner with the typed field below it', () => {
  setMode('sidebar', true);
  renderScan();

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  const typedField = screen.getByPlaceholderText('Or type the code (TLY-…)');
  expect(typedField).toBeTruthy();

  // Scanner-first: the typed field is BELOW the scanner in document order,
  // matching the phone layout rather than the desk's typed-first one.
  const scanner = screen.getByTestId('tag-scanner');
  expect(scanner.compareDocumentPosition(typedField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // The fine-desk-only "Use the camera instead" opt-in never appears here —
  // the scanner is already up front, not behind a button.
  expect(screen.queryByRole('button', { name: /use the camera instead/i })).toBeNull();
});

test('sidebar+coarse does NOT autofocus the typed field', async () => {
  setMode('sidebar', true);
  renderScan();

  const typedField = screen.getByPlaceholderText('Or type the code (TLY-…)');
  // Give the autofocus effect a turn to run, in case the fix regresses.
  await waitFor(() => expect(screen.getByTestId('tag-scanner')).toBeTruthy());
  expect(document.activeElement).not.toBe(typedField);
});

test('sidebar+fine keeps today\'s typed-first layout AND the autofocus (regression pin)', async () => {
  setMode('sidebar', false);
  renderScan();

  const typedField = screen.getByPlaceholderText('Type or scan a code (TLY-…)');
  expect(typedField).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(typedField));

  // No scanner up front — a fine-pointer desk still gets the opt-in button,
  // not a camera immediately running.
  expect(screen.queryByTestId('tag-scanner')).toBeNull();
  expect(screen.getByRole('button', { name: /use the camera instead/i })).toBeTruthy();
});

test('phone (non-sidebar) is unchanged: scanner first, typed field below, no autofocus', async () => {
  setMode('touch', false);
  renderScan();

  const scanner = screen.getByTestId('tag-scanner');
  expect(scanner).toBeTruthy();
  const typedField = screen.getByPlaceholderText('Or type the code (TLY-…)');
  expect(scanner.compareDocumentPosition(typedField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await waitFor(() => expect(screen.getByTestId('tag-scanner')).toBeTruthy());
  expect(document.activeElement).not.toBe(typedField);
  expect(screen.queryByRole('button', { name: /use the camera instead/i })).toBeNull();
});

test('phone (non-sidebar) is unchanged even when the pointer happens to read coarse', () => {
  // A phone is always coarse in real life, but the fork is `!atDesk ||
  // coarse` — this pins that a phone renders identically regardless of what
  // useCoarsePointer reports, since !atDesk alone already forces showScanner.
  setMode('touch', true);
  renderScan();

  expect(screen.getByTestId('tag-scanner')).toBeTruthy();
  expect(screen.getByPlaceholderText('Or type the code (TLY-…)')).toBeTruthy();
});
