// @vitest-environment jsdom
/**
 * #283 — the bulk-tag dialog was 384px wide on a 1440px screen AND kept the
 * property's tags folded behind a collapsed "+ ADD TAG" dropdown, in a dialog
 * whose entire job is picking one of them. The dialog is now `sm:max-w-lg`
 * (container-detail.tsx) and batch mode lays the choice out flat.
 *
 * Also pinned here: `batchMode.busy`, which the props doc has always described
 * as disabling tag selection while the caller's per-entity loop runs, and
 * which nothing in this component ever read.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi, beforeEach } from 'vitest';
import { TagPicker } from './tag-picker';

const TAGS = [
  { id: 1, propertyId: 1, name: 'Fragile', color: '#e11d48' },
  { id: 2, propertyId: 1, name: 'Seasonal', color: '#0ea5e9' },
  { id: 3, propertyId: 1, name: 'Insured', color: '#16a34a' },
];

let propertyTags = TAGS;

vi.mock('@/hooks/use-tags', () => ({
  useEntityTags: () => ({ data: [] }),
  usePropertyTags: () => ({ data: propertyTags }),
  useAddTag: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveTag: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateTag: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/components/ui/toast', () => {
  const toastFn = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast: toastFn };
});

beforeEach(() => {
  propertyTags = TAGS;
});

const onApply = vi.fn();

function renderBatch(busy = false) {
  onApply.mockClear();
  return render(
    <TagPicker entityType="item" entityId={0} propertyId={1} batchMode={{ onApply, busy }} />,
  );
}

test('batch mode lists every tag on the page — no click needed to see the choice', () => {
  renderBatch();

  for (const tag of TAGS) {
    expect(screen.getByRole('button', { name: new RegExp(`^${tag.name}$`, 'i') })).toBeTruthy();
  }
});

test('picking one applies it straight away, in one click rather than two', () => {
  renderBatch();

  fireEvent.click(screen.getByRole('button', { name: /^seasonal$/i }));
  expect(onApply).toHaveBeenCalledWith(2);
});

test('the dropdown is now only for creating a new tag, and says so', () => {
  renderBatch();

  expect(screen.getByRole('button', { name: /new tag/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^add tag$/i })).toBeNull();
});

test('opening it offers the create form and does NOT repeat the list above it', () => {
  renderBatch();
  fireEvent.click(screen.getByRole('button', { name: /new tag/i }));

  expect(screen.getByPlaceholderText(/tag name/i)).toBeTruthy();
  expect(screen.queryByText(/apply tag/i)).toBeNull();
  // Still exactly one button per tag — the flat list, not a second copy.
  expect(screen.getAllByRole('button', { name: /^fragile$/i }).length).toBe(1);
});

test('a property with no tags yet says so instead of showing an empty row of nothing', () => {
  propertyTags = [];
  renderBatch();

  expect(screen.getByText(/no tags in this property yet/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /new tag/i })).toBeTruthy();
});

test('busy disables selection — the doc has always said it does, and nothing read it', () => {
  renderBatch(true);

  const fragile = screen.getByRole('button', { name: /^fragile$/i }) as HTMLButtonElement;
  expect(fragile.disabled).toBe(true);
  fireEvent.click(fragile);
  expect(onApply).not.toHaveBeenCalled();

  expect((screen.getByRole('button', { name: /new tag/i }) as HTMLButtonElement).disabled).toBe(true);
});

test('outside batch mode the dropdown is unchanged — a detail page is not a picker dialog', () => {
  render(<TagPicker entityType="item" entityId={5} propertyId={1} />);

  // Nothing inline; the trigger keeps its own wording.
  expect(screen.queryByRole('button', { name: /^fragile$/i })).toBeNull();
  expect(screen.getByRole('button', { name: /add tag/i })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
  expect(screen.getByText(/apply tag/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /^fragile$/i })).toBeTruthy();
});
