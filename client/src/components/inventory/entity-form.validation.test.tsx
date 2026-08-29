// @vitest-environment jsdom
/**
 * Client-side validation (#94): entity-form.tsx had no schema of its own —
 * CLAUDE.md documented "Zod + react-hook-form" as the convention, but a bad
 * value (a fractional quantity, a free-text condition) just round-tripped to
 * the server for a Joi 400 the user couldn't act on. This locks in the
 * minimal fix: quantity is bounded to a whole number >= 1, condition is a
 * closed select, and both are gated by a zod schema per entity type
 * (schemasByType in entity-form.tsx) that mirrors the corresponding Joi
 * schema in server/src/modules/inventory/*.schema.js.
 *
 * Uses the same render-and-fireEvent idiom as create-container-dialog.test.tsx
 * — EntityForm is a real form control, no Router/QueryClient needed.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { EntityForm } from './entity-form';

function fillName(value = 'Table') {
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /create/i }));
}

test('condition select offers exactly the four Joi-valid values, no "Other…" escape hatch', () => {
  render(<EntityForm open onOpenChange={() => {}} type="item" onSubmit={vi.fn()} />);

  const conditionSelect = screen.getByLabelText('Condition') as HTMLSelectElement;
  // The placeholder plus exactly the four enum values — nothing else, and
  // notably no "Other…" (closed:true suppresses it, same as `completeness`).
  const optionTexts = within(conditionSelect).getAllByRole('option').map((o) => o.textContent);
  expect(optionTexts).toEqual(['Select…', 'New', 'Good', 'Fair', 'Poor']);

  const values = within(conditionSelect).getAllByRole('option').map(
    (o) => (o as HTMLOptionElement).value,
  );
  expect(values).toEqual(['', 'new', 'good', 'fair', 'poor']);
});

test.each([
  ['0', 'zero'],
  ['-1', 'negative'],
  ['1.5', 'fractional'],
])('quantity=%s (%s) blocks submit with a field error', async (badValue) => {
  const onSubmit = vi.fn();
  render(<EntityForm open onOpenChange={() => {}} type="item" onSubmit={onSubmit} />);

  fillName();
  fireEvent.change(screen.getByLabelText(/^quantity/i), { target: { value: badValue } });
  submit();

  await waitFor(() => {
    expect(screen.getByLabelText(/^quantity/i).getAttribute('aria-invalid')).toBe('true');
  });
  expect(screen.getByText(/quantity must be a whole number/i)).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('a blank quantity is valid (server defaults it to 1) — no error, submit proceeds', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<EntityForm open onOpenChange={() => {}} type="item" onSubmit={onSubmit} />);

  fillName();
  submit();

  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('quantity');
});

test('a valid submit produces the same cleaned payload as before — regression pin', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<EntityForm open onOpenChange={() => {}} type="item" onSubmit={onSubmit} />);

  fillName('Lamp');
  fireEvent.change(screen.getByLabelText(/^quantity/i), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText(/^purchase price/i), { target: { value: '9.99' } });
  fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'good' } });
  submit();

  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  // Same shape the pre-existing handleFormSubmit cleaning step always
  // produced: empty fields (description, completeness) dropped entirely,
  // number fields coerced to actual numbers.
  expect(onSubmit).toHaveBeenCalledWith({
    name: 'Lamp',
    quantity: 3,
    purchasePrice: 9.99,
    condition: 'good',
  });
});

test('name at the Joi boundary: 255 chars is valid, 256 blocks submit with a field error', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<EntityForm open onOpenChange={() => {}} type="property" onSubmit={onSubmit} />);

  const name = screen.getByLabelText(/^name/i);
  fireEvent.change(name, { target: { value: 'A'.repeat(256) } });
  submit();
  await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
  expect(screen.getByText(/limited to 255 characters/i)).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.change(name, { target: { value: 'A'.repeat(255) } });
  submit();
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'A'.repeat(255) }));
});

test('an empty name blocks submit with "Name is required"', async () => {
  const onSubmit = vi.fn();
  render(<EntityForm open onOpenChange={() => {}} type="area" onSubmit={onSubmit} />);

  submit();

  await waitFor(() => {
    expect(screen.getByLabelText(/^name/i).getAttribute('aria-invalid')).toBe('true');
  });
  expect(screen.getByText('Name is required')).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
});
