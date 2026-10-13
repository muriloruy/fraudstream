import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStreamEvent } from '../../../lib/event-stream';
import { session } from '../../../lib/session';
import { alertItem } from '../../../test/fixtures';
import { json, login, mockFetch, on, renderAt } from '../../../test/utils';
import AlertQueuePage from './alert-queue-page';

afterEach(() => {
  session.clear();
  window.scrollY = 0;
});

const scrollTo = (y: number) => {
  window.scrollY = y;
  fireEvent.scroll(window);
};

describe('Alert Queue (SPEC §8.2)', () => {
  it('renders the table columns and loads more with the cursor', async () => {
    login();
    const first = alertItem({ accountId: 'acc_page1', firedRules: ['R006', 'R001'] });
    const second = alertItem({ accountId: 'acc_page2' });
    const { calls } = mockFetch(
      on('GET', '/v1/alerts', (req) =>
        json(
          new URL(req.url).searchParams.get('cursor') === 'c1'
            ? { items: [second], nextCursor: null }
            : { items: [first], nextCursor: 'c1' },
        ),
      ),
    );
    renderAt(<AlertQueuePage />);
    const row = await screen.findByText('acc_page1');
    const cells = within(row.closest('tr') as HTMLElement);
    expect(cells.getByText('R006')).toBeInTheDocument();
    expect(cells.getByText('Loja Exemplo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('acc_page2')).toBeInTheDocument();
    expect(new URL(calls.at(-1)?.url ?? '').searchParams.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('sends the filters to the gateway', async () => {
    login();
    const { calls } = mockFetch(
      on('GET', '/v1/alerts', () => json({ items: [], nextCursor: null })),
    );
    renderAt(<AlertQueuePage />);
    await screen.findByText('No alerts match these filters.');
    await userEvent.type(screen.getByLabelText('Min score'), '0.8');
    await userEvent.type(screen.getByLabelText('Account'), 'acc_9');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const params = new URL(calls.at(-1)?.url ?? '').searchParams;
      expect(params.get('minScore')).toBe('0.8');
      expect(params.get('accountId')).toBe('acc_9');
      expect(params.get('status')).toBe('OPEN,IN_PROGRESS');
    });
  });

  it('inserts live alerts at the top, or counts them while the user is scrolled down', async () => {
    login();
    mockFetch(
      on('GET', '/v1/alerts', () =>
        json({ items: [alertItem({ accountId: 'acc_old' })], nextCursor: null }),
      ),
    );
    const { client } = renderAt(<AlertQueuePage />);
    await screen.findByText('acc_old');

    act(() => {
      applyStreamEvent(client, 'alert.created', alertItem({ accountId: 'acc_live_top' }));
    });
    const top = await screen.findByText('acc_live_top');
    expect(top.closest('tr')).toHaveClass('animate-highlight');
    expect(screen.getAllByTestId('alert-row')[0]).toContainElement(top);

    act(() => {
      scrollTo(800);
      applyStreamEvent(client, 'alert.created', alertItem({ accountId: 'acc_live_hidden' }));
    });
    const counter = await screen.findByRole('button', { name: '1 new alert' });
    expect(screen.queryByText('acc_live_hidden')).not.toBeInTheDocument();
    await userEvent.click(counter);
    const shown = await screen.findByText('acc_live_hidden');
    expect(shown.closest('tr')).toHaveClass('animate-highlight');
    expect(screen.queryByRole('button', { name: /new alert/ })).not.toBeInTheDocument();
  });

  it('ignores live alerts that do not match the filters', async () => {
    login();
    mockFetch(on('GET', '/v1/alerts', () => json({ items: [], nextCursor: null })));
    const { client } = renderAt(<AlertQueuePage />);
    await screen.findByText('No alerts match these filters.');
    act(() => {
      applyStreamEvent(
        client,
        'alert.created',
        alertItem({ accountId: 'acc_closed', status: 'LEGITIMATE' }),
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('acc_closed')).not.toBeInTheDocument();
  });
});
