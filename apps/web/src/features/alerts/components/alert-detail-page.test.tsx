import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../../lib/session';
import { alertDetail } from '../../../test/fixtures';
import { a11yViolations, json, login, mockFetch, on, problem, renderAt } from '../../../test/utils';
import AlertDetailPage from './alert-detail-page';

afterEach(() => {
  session.clear();
});

const timeline = on('GET', /\/timeline$/, () => json({ accountId: 'acc_000123', items: [] }));

/** The last match: the dialog's submit button repeats the label of the button that opened it. */
function last(elements: HTMLElement[]): HTMLElement {
  const element = elements.at(-1);
  if (!element) throw new Error('no element');
  return element;
}

function renderDetail(id: string) {
  return renderAt(<AlertDetailPage />, `/alerts/${id}`, '/alerts/:id');
}

describe('Alert Detail (SPEC §8.2)', () => {
  it('shows the transaction with the masked PAN and the score breakdown', async () => {
    login();
    const a = alertDetail();
    mockFetch(
      on('GET', `/v1/alerts/${a.alertId}`, () => json(a)),
      timeline,
    );
    const { container } = renderDetail(a.alertId);
    expect(await screen.findByText('411111******1111')).toBeInTheDocument();
    expect(screen.getByText('velocity_1m')).toBeInTheDocument();
    expect(screen.getByText('rules 60% · anomaly 40%')).toBeInTheDocument();
    expect(screen.getByText('4.20')).toBeInTheDocument(); // amount z-score
    expect(
      screen.getByRole('img', { name: /Final score 0.6960; approve below 0.4, decline from 0.75/ }),
    ).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it('requires a note: an empty resolution sends nothing', async () => {
    login();
    const a = alertDetail();
    const { calls } = mockFetch(
      on('GET', `/v1/alerts/${a.alertId}`, () => json(a)),
      timeline,
    );
    renderDetail(a.alertId);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark legitimate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark legitimate' });
    await userEvent.click(last(screen.getAllByRole('button', { name: 'Mark legitimate' })));
    expect(await screen.findByText('A note is required')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/resolve'))).toBe(false);
  });

  it('applies a resolution optimistically and rolls it back on error', async () => {
    login();
    const a = alertDetail();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFetch(
      on('GET', `/v1/alerts/${a.alertId}`, () => json(a)),
      timeline,
      on('POST', `/v1/alerts/${a.alertId}/resolve`, async () => {
        await gate;
        return problem(500, 'Internal Server Error');
      }),
    );
    renderDetail(a.alertId);
    expect(await screen.findByTestId('alert-status')).toHaveTextContent('OPEN');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm fraud' }));
    await userEvent.type(await screen.findByLabelText('Note'), 'card testing pattern');
    await userEvent.click(last(screen.getAllByRole('button', { name: 'Confirm fraud' })));

    await waitFor(() => {
      expect(screen.getByTestId('alert-status')).toHaveTextContent('CONFIRMED FRAUD'); // optimistic
    });
    release();
    await waitFor(() => {
      expect(screen.getByTestId('alert-status')).toHaveTextContent('OPEN'); // rolled back
    });
    expect(await screen.findByText('Could not resolve the alert')).toBeInTheDocument();
  });

  it('can be triaged with the keyboard only', async () => {
    login();
    const a = alertDetail();
    const { calls } = mockFetch(
      on('GET', `/v1/alerts/${a.alertId}`, () => json(a)),
      timeline,
      on('POST', `/v1/alerts/${a.alertId}/resolve`, () => json({ ...a, status: 'LEGITIMATE' })),
    );
    renderDetail(a.alertId);
    await screen.findByTestId('alert-status');
    const legit = screen.getByRole('button', { name: 'Mark legitimate' });
    legit.focus();
    await userEvent.keyboard('{Enter}');
    const note = await screen.findByLabelText('Note');
    await waitFor(() => {
      expect(note).toHaveFocus();
    });
    await userEvent.keyboard('verified with the customer');
    await userEvent.tab(); // Cancel
    await userEvent.tab(); // Mark legitimate (submit)
    expect(document.activeElement).toHaveTextContent('Mark legitimate');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/resolve'))).toBe(true);
    });
  });
});
