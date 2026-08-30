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

/*
 * #280 — the scanner column's height cap must exist off the landscape axis.
 *
 * The clamp used to be `atDesk && coarse`, i.e. landscape only, so an iPad in
 * PORTRAIT ran with none: `flex-1` took the whole leftover column (851px
 * measured at 820x1180) around a frame that stops at its own 420px, and the
 * typed-code field and Go landed at y=1020 — 418px below the scanner's own
 * controls and 91px above the bottom nav.
 *
 * Two things are pinned here, and the first matters more than the second.
 *
 * The FLEX CHAIN is unconditional on every surface. `flex flex-col flex-1
 * min-h-0` on this wrapper is what lets TagScanner's own flex-1 grow at all;
 * making it conditional is the ~200px collapse this codebase has shipped
 * twice. Only the CLAMP may fork.
 *
 * The clamp class is the same string on a phone and on a portrait tablet on
 * purpose — the discrimination is in CSS, not here: --scanner-max is `none`
 * below 768px (globals.css), so the phone is left alone by construction
 * rather than by trusting it to come in under a number. jsdom does no layout
 * and Tailwind is compiled by Vite, so a computed-style assertion would report
 * the same thing before and after the fix; the class is what changed.
 */
test('#280 the portrait/phone scanner wrapper keeps the flex chain AND gains a cap', () => {
  setMode('touch', true);
  renderScan();
  const wrapper = screen.getByTestId('tag-scanner').parentElement!;
  for (const c of ['flex', 'flex-col', 'flex-1', 'min-h-0']) {
    expect(wrapper.className.split(/\s+/)).toContain(c);
  }
  expect(wrapper.className).toContain('max-h-[var(--scanner-max)]');
});

test('#280 landscape keeps its audited vh clamp, not the portrait one', () => {
  setMode('sidebar', true);
  renderScan();
  const wrapper = screen.getByTestId('tag-scanner').parentElement!;
  for (const c of ['flex', 'flex-col', 'flex-1', 'min-h-0']) {
    expect(wrapper.className.split(/\s+/)).toContain(c);
  }
  expect(wrapper.className).toContain('max-h-[clamp(230px,36vh,280px)]');
  expect(wrapper.className).not.toContain('--scanner-max');
});

test('#280 a fine pointer gets no cap at all — the wrapper is chain-only', () => {
  setMode('touch', false);
  renderScan();
  const wrapper = screen.getByTestId('tag-scanner').parentElement!;
  for (const c of ['flex', 'flex-col', 'flex-1', 'min-h-0']) {
    expect(wrapper.className.split(/\s+/)).toContain(c);
  }
  expect(wrapper.className).not.toContain('max-h-');
});
