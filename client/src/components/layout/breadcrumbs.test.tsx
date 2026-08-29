// @vitest-environment jsdom
/**
 * "Back to Alerts" affordance (#229).
 *
 * The notification list's click handler navigates into a detail page with
 * `{state:{from:'alerts'}}` (see notification-list.tsx). Every one of the
 * four pages that can be a notification target — item, container, area,
 * property detail — renders this shared Breadcrumbs component, so it is the
 * one place a conditional back-link needs to live rather than threading the
 * affordance through four separate pages.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, test } from 'vitest';
import { Breadcrumbs } from './breadcrumbs';

function renderWithState(state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/item/1', state }]}>
      <Routes>
        <Route path="/item/:id" element={<Breadcrumbs items={[]} />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('renders a back-to-alerts link when navigated with state.from === "alerts"', () => {
  renderWithState({ from: 'alerts' });
  const link = screen.getByRole('link', { name: /back to alerts/i });
  expect(link.getAttribute('href')).toBe('/notifications');
});

test('renders no back link on an ordinary navigation (no state)', () => {
  renderWithState(undefined);
  expect(screen.queryByRole('link', { name: /back to alerts/i })).toBeNull();
});

test('renders no back link when state.from is something else', () => {
  renderWithState({ from: 'search' });
  expect(screen.queryByRole('link', { name: /back to alerts/i })).toBeNull();
});
