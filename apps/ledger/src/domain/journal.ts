import { fromCents, toCents, type LedgerEntry } from '@fraudstream/contracts';

/** What the ledger needs from an approved transaction (decision + projected transaction). */
export interface ApprovedTransaction {
  transactionId: string;
  accountId: string;
  merchantId: string;
  amount: string; // decimal string, never a float (ADR-009)
  currency: string;
}

export const customerAccount = (accountId: string): string => `customer:${accountId}`;
export const merchantAccount = (merchantId: string): string => `merchant:${merchantId}`;

/**
 * SPEC §6.7: an approval moves the amount from the cardholder to the merchant, one journal with
 * a DEBIT on `customer:<accountId>` and a CREDIT on `merchant:<merchantId>`.
 */
export function buildJournal(tx: ApprovedTransaction): LedgerEntry[] {
  const amount = fromCents(toCents(tx.amount)); // canonical form, e.g. "1250.9" → "1250.90"
  const currency = tx.currency as LedgerEntry['currency'];
  return [
    { ledgerAccount: customerAccount(tx.accountId), direction: 'DEBIT', amount, currency },
    { ledgerAccount: merchantAccount(tx.merchantId), direction: 'CREDIT', amount, currency },
  ];
}

export interface BalanceDelta {
  ledgerAccount: string;
  currency: string;
  /** Signed decimal string: credits increase a balance, debits decrease it. */
  delta: string;
}

/**
 * Balance changes of a journal, one per account, in a stable order (by account name) so that
 * concurrent postings always lock balance rows in the same order and cannot deadlock.
 * The deltas of a balanced journal sum to zero per currency.
 */
export function balanceDeltas(entries: readonly LedgerEntry[]): BalanceDelta[] {
  const byAccount = new Map<string, { currency: string; cents: bigint }>();
  for (const e of entries) {
    const signed = e.direction === 'CREDIT' ? toCents(e.amount) : -toCents(e.amount);
    const current = byAccount.get(e.ledgerAccount);
    byAccount.set(e.ledgerAccount, {
      currency: e.currency,
      cents: (current?.cents ?? 0n) + signed,
    });
  }
  return [...byAccount.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ledgerAccount, { currency, cents }]) => ({
      ledgerAccount,
      currency,
      delta: fromCents(cents),
    }));
}
