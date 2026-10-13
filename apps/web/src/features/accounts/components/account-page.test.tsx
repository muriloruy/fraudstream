import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../../lib/session';
import { json, login, mockFetch, on, renderAt } from '../../../test/utils';
import AccountPage from './account-page';

afterEach(() => {
  session.clear();
});

describe('Account Timeline (SPEC §8.2)', () => {
  it('shows profile, balance, stats and both entry types newest first', async () => {
    login();
    mockFetch(
      on('GET', '/v1/accounts/acc_1', () =>
        json({
          accountId: 'acc_1',
          profile: {
            homeCountry: 'BR',
            homeCity: 'Recife',
            riskTier: 'HIGH',
            creditLimit: '5000.00',
          },
          balance: { currency: 'BRL', balance: '-10.30' },
          stats: {
            transactions: 2,
            averageAmount: '5.15',
            approve: 1,
            review: 1,
            decline: 0,
            openAlerts: 1,
          },
        }),
      ),
      on('GET', '/v1/accounts/acc_1/timeline', () =>
        json({
          accountId: 'acc_1',
          items: [
            {
              kind: 'LEDGER',
              transactionId: '01a13274-cfe8-7607-9cef-b353da9c1918',
              occurredAt: '2026-10-12T18:00:01.000000Z',
              amount: { value: '10.30', currency: 'BRL' },
              payload: {
                transactionId: '01a13274-cfe8-7607-9cef-b353da9c1918',
                accountId: 'acc_1',
                journalId: '0192f1c4-0000-7000-8000-000000000001',
                entries: [
                  {
                    ledgerAccount: 'customer:acc_1',
                    direction: 'DEBIT',
                    amount: '10.30',
                    currency: 'BRL',
                  },
                  {
                    ledgerAccount: 'merchant:m',
                    direction: 'CREDIT',
                    amount: '10.30',
                    currency: 'BRL',
                  },
                ],
                postedAt: '2026-10-12T18:00:01.000Z',
              },
            },
            {
              kind: 'DECISION',
              transactionId: '01a13274-cfe8-7607-9cef-b353da9c1918',
              occurredAt: '2026-10-12T18:00:00.000000Z',
              amount: { value: '10.30', currency: 'BRL' },
              payload: {
                transactionId: '01a13274-cfe8-7607-9cef-b353da9c1918',
                accountId: 'acc_1',
                decision: 'APPROVE',
                finalScore: 0.1,
                components: { ruleScore: 0.1, anomalyScore: 0.1 },
                reasons: [],
                partial: false,
                decidedAt: '2026-10-12T18:00:00.000Z',
                latencyMs: 120,
              },
            },
          ],
        }),
      ),
    );
    renderAt(<AccountPage />, '/accounts/acc_1', '/accounts/:id');
    expect(await screen.findByText('Recife, BR')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.getByTestId('balance')).toHaveTextContent('-R$');
    const rows = await screen.findAllByTestId('timeline-row');
    expect(rows.map((r) => r.dataset.kind)).toEqual(['LEDGER', 'DECISION']);
    expect(rows[1]).toHaveTextContent('APPROVE');
  });
});
