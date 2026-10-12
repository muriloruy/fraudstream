import { z } from 'zod';
import {
  AccountId,
  CurrencyCode,
  isDecimalString,
  PositiveDecimalString,
  toCents,
  UtcDateTime,
  Uuid,
  UuidV7,
} from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const EntryDirection = z.enum(['DEBIT', 'CREDIT']);

export const LedgerEntry = z.object({
  ledgerAccount: z
    .string()
    .regex(/^(customer|merchant):.+$/, 'must be customer:<id> or merchant:<id>'),
  direction: EntryDirection,
  amount: PositiveDecimalString,
  currency: CurrencyCode,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** True when debits equal credits for every currency (double-entry invariant, SPEC §5.6). */
export function isBalanced(entries: readonly LedgerEntry[]): boolean {
  const net = new Map<string, bigint>();
  for (const entry of entries) {
    if (!isDecimalString(entry.amount)) return false;
    const cents = toCents(entry.amount);
    const signed = entry.direction === 'DEBIT' ? cents : -cents;
    net.set(entry.currency, (net.get(entry.currency) ?? 0n) + signed);
  }
  return [...net.values()].every((total) => total === 0n);
}

/** `ledger.entries.v1` (SPEC §4.9). */
export const LedgerEntriesPostedV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  journalId: Uuid,
  entries: z
    .array(LedgerEntry)
    .min(2)
    .refine(isBalanced, { message: 'debits must equal credits per currency' }),
  postedAt: UtcDateTime,
});
export type LedgerEntriesPostedV1 = z.infer<typeof LedgerEntriesPostedV1>;

export const LedgerEntriesPosted = defineEvent({
  eventType: 'LedgerEntriesPosted',
  eventVersion: 1,
  topic: Topics.ledgerEntries,
  payload: LedgerEntriesPostedV1,
});
