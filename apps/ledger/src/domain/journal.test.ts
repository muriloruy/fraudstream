import { isBalanced, toCents } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { balanceDeltas, buildJournal, type ApprovedTransaction } from './journal.js';

const tx: ApprovedTransaction = {
  transactionId: '0192f1c4-0000-7000-8000-000000000001',
  accountId: 'acc_1',
  merchantId: 'mer_9',
  amount: '1250.9',
  currency: 'BRL',
};

describe('buildJournal (SPEC §6.7)', () => {
  it('debits the customer and credits the merchant with the exact amount', () => {
    expect(buildJournal(tx)).toEqual([
      { ledgerAccount: 'customer:acc_1', direction: 'DEBIT', amount: '1250.90', currency: 'BRL' },
      { ledgerAccount: 'merchant:mer_9', direction: 'CREDIT', amount: '1250.90', currency: 'BRL' },
    ]);
  });

  it.each(['0.01', '0.10', '0.30', '9999999999999999.99', '1000000.00'])(
    'is balanced and exact for %s (no floating point)',
    (amount) => {
      const entries = buildJournal({ ...tx, amount });
      expect(isBalanced(entries)).toBe(true);
      expect(entries.every((e) => toCents(e.amount) === toCents(amount))).toBe(true);
    },
  );
});

describe('balanceDeltas', () => {
  it('decreases the customer, increases the merchant, sums to zero, sorted by account', () => {
    const deltas = balanceDeltas(buildJournal({ ...tx, accountId: 'zed', merchantId: 'abc' }));
    expect(deltas).toEqual([
      { ledgerAccount: 'customer:zed', currency: 'BRL', delta: '-1250.90' },
      { ledgerAccount: 'merchant:abc', currency: 'BRL', delta: '1250.90' },
    ]);
    // fromCents always writes 2 decimals, so dropping the point gives signed cents.
    expect(deltas.reduce((sum, d) => sum + BigInt(d.delta.replace('.', '')), 0n)).toBe(0n);
  });

  it('nets several entries of one account into one delta', () => {
    const deltas = balanceDeltas([
      { ledgerAccount: 'merchant:m', direction: 'CREDIT', amount: '10.00', currency: 'USD' },
      { ledgerAccount: 'merchant:m', direction: 'DEBIT', amount: '0.25', currency: 'USD' },
      { ledgerAccount: 'customer:c', direction: 'DEBIT', amount: '9.75', currency: 'USD' },
    ]);
    expect(deltas).toEqual([
      { ledgerAccount: 'customer:c', currency: 'USD', delta: '-9.75' },
      { ledgerAccount: 'merchant:m', currency: 'USD', delta: '9.75' },
    ]);
  });
});
