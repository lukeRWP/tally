// @vitest-environment jsdom
/**
 * #284 — a field error was a bare <span>: aria-invalid told a screen-reader
 * user the control was wrong, but nothing tied the invalid control to the
 * message explaining WHY. Fixed by giving the error span a stable id and
 * role="alert", and pointing the control's aria-describedby at it whenever
 * that field is invalid.
 *
 * Same render idiom as entity-form.validation.test.tsx.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { EntityForm } from './entity-form';

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /create/i }));
}

test('an invalid field ties its input to its error message via aria-describedby + role=alert', async () => {
  const onSubmit = vi.fn();
  render(<EntityForm open onOpenChange={() => {}} type="area" onSubmit={onSubmit} />);

  // No name typed — submit fails validation on the required field.
  submit();

  const nameInput = await screen.findByLabelText(/^name/i);
  await waitFor(() => expect(nameInput.getAttribute('aria-invalid')).toBe('true'));

  const describedBy = nameInput.getAttribute('aria-describedby');
  expect(describedBy).toBe('name-err');

  const errorEl = document.getElementById(describedBy!);
  expect(errorEl).toBeTruthy();
  expect(errorEl!.textContent).toBe('Name is required');
  expect(errorEl!.getAttribute('role')).toBe('alert');

  expect(onSubmit).not.toHaveBeenCalled();
});

test('a valid field carries no aria-describedby at all', () => {
  render(<EntityForm open onOpenChange={() => {}} type="area" onSubmit={vi.fn()} />);

  const nameInput = screen.getByLabelText(/^name/i);
  expect(nameInput.hasAttribute('aria-describedby')).toBe(false);
});
