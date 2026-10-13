import { act, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyStreamEvent } from '../../../lib/event-stream';
import { session } from '../../../lib/session';
import { summary } from '../../../test/fixtures';
import { admin, json, login, mockFetch, on, renderAt } from '../../../test/utils';
import MonitorPage from './monitor-page';

afterEach(() => {
  session.clear();
});

// jsdom has no layout: give elements a size so the virtualized feed renders rows.
const size = { offsetHeight: 400, offsetWidth: 600 };
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(size)) {
    saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

describe('Live Monitor (SPEC §8.2)', () => {
  it('updates the KPI cards on metrics.tick without reloading', async () => {
    login();
    mockFetch(on('GET', '/v1/metrics/summary', () => json(summary({ transactionsPerSecond: 1 }))));
    const { client } = renderAt(<MonitorPage />);
    expect(await screen.findByText('1.00')).toBeInTheDocument();
    act(() => {
      applyStreamEvent(
        client,
        'metrics.tick',
        summary({ transactionsPerSecond: 7.5, rates: { approve: 0.5, review: 0.3, decline: 0.2 } }),
      );
    });
    expect(await screen.findByText('7.50')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-Decline')).toHaveTextContent('20.0%');
  });

  it('shows decisions from the stream in the feed', async () => {
    login();
    mockFetch(on('GET', '/v1/metrics/summary', () => json(summary())));
    const { client } = renderAt(<MonitorPage />);
    act(() => {
      applyStreamEvent(client, 'decision.made', {
        transactionId: '01a13274-cfe8-7607-9cef-b353da9c1918',
        accountId: 'acc_feed',
        decision: 'DECLINE',
        finalScore: 0.91,
        components: { ruleScore: 1, anomalyScore: 0.7 },
        reasons: [],
        partial: false,
        decidedAt: new Date().toISOString(),
        latencyMs: 210,
      });
    });
    expect(await screen.findByText('acc_feed')).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent('DECLINE');
  });

  it('hides consumer lag from analysts and shows it to admins', async () => {
    login();
    mockFetch(
      on('GET', '/v1/metrics/summary', () => json(summary())),
      on('GET', '/admin/consumers/lag', () =>
        json({
          items: [
            { group: 'ledger', topic: 't', partition: 0, committed: '1', end: '5', lag: '4' },
          ],
        }),
      ),
    );
    const view = renderAt(<MonitorPage />);
    await screen.findByText('2.00');
    expect(screen.queryByLabelText('Consumer lag')).not.toBeInTheDocument();
    view.unmount();

    login(admin);
    renderAt(<MonitorPage />);
    const lag = await screen.findByTestId('kpi-Consumer lag');
    await waitFor(() => {
      expect(lag).toHaveTextContent('4');
    });
  });
});
