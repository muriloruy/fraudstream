import { createHash } from 'node:crypto';
import {
  AccountProfileUpserted,
  createEnvelope,
  TransactionAuthorizationRequested,
  uuidv7,
  type AccountProfileUpsertedV1,
  type Envelope,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import {
  eventHeaders,
  sendMessages,
  type OutgoingMessage,
  type Producer,
} from '@fraudstream/kafka';
import { hashWithPepper, maskPan } from '@fraudstream/security';
import { accountHistory, type HistoricalTransaction } from '../domain/history.js';
import { Random } from '../domain/random.js';
import { buildWorld, type Account } from '../domain/world.js';

/**
 * Producer name of seed events. History bypasses the API (which stamps `requestedAt`
 * itself), so it is published directly; the name tags it in every envelope (M7 design).
 * Seed decisions are not in the ground truth, so `pnpm eval` never counts them.
 */
export const SEED_PRODUCER = 'simulator-seed';
const BATCH = 1000;

export interface SeedOptions {
  accounts: number;
  seed: number;
  days: number;
  /** Pepper of the API (HASH_PEPPER), so seeded device hashes match live ones. */
  hashPepper: string;
  /** History ends one hour before this instant (default: now). */
  now?: Date;
  onProgress?: (published: { profiles: number; transactions: number }) => void;
}

export interface SeedResult {
  profiles: number;
  transactions: number;
}

export function profileEnvelope(account: Account, now: Date): Envelope<AccountProfileUpsertedV1> {
  return createEnvelope({
    eventType: AccountProfileUpserted.eventType,
    eventVersion: AccountProfileUpserted.eventVersion,
    producer: SEED_PRODUCER,
    correlationId: uuidv7(now.getTime()),
    now,
    payload: AccountProfileUpserted.payload.parse({
      accountId: account.accountId,
      homeCountry: account.homeCity.country,
      homeCity: account.homeCity.name,
      createdAt: new Date(now.getTime() - 400 * 86_400_000).toISOString(),
      riskTier: account.riskTier,
      creditLimit: account.creditLimit,
    }),
  });
}

/** A past authorization exactly as transaction-api would have published it. */
export function historyEnvelope(
  { at, tx }: HistoricalTransaction,
  hashPepper: string,
): Envelope<TransactionAuthorizationRequestedV1> {
  const transactionId = uuidv7(at.getTime());
  return createEnvelope({
    eventType: TransactionAuthorizationRequested.eventType,
    eventVersion: TransactionAuthorizationRequested.eventVersion,
    producer: SEED_PRODUCER,
    correlationId: transactionId,
    now: at,
    payload: TransactionAuthorizationRequested.payload.parse({
      transactionId,
      accountId: tx.account.accountId,
      // Not a vault token (the vault is not involved), but the same shape; rules ignore it.
      cardToken: `tok_sim${createHash('sha256').update(tx.account.card.pan).digest('hex').slice(0, 24)}`,
      maskedPan: maskPan(tx.account.card.pan),
      amount: { value: tx.amount, currency: 'BRL' },
      merchant: {
        id: tx.merchant.id,
        name: tx.merchant.name,
        mcc: tx.merchant.mcc,
        country: tx.merchant.city.country,
        city: tx.merchant.city.name,
      },
      channel: tx.channel,
      entryMode: tx.entryMode,
      device: {
        ipHash: hashWithPepper(tx.ip, hashPepper),
        deviceIdHash: hashWithPepper(tx.deviceId, hashPepper),
      },
      geo: tx.geo,
      requestedAt: at.toISOString(),
    }),
  });
}

/**
 * `sim:seed` (SPEC §6.9): the account profiles, then each account's 30 days of history in
 * time order (keyed by account, so one partition keeps that order). History ends an hour
 * ago, so baselines are complete when live traffic starts.
 */
export async function seed(producer: Producer, options: SeedOptions): Promise<SeedResult> {
  const now = options.now ?? new Date();
  const world = buildWorld(options.seed, options.accounts);
  const random = new Random(options.seed).fork('history');
  const result: SeedResult = { profiles: 0, transactions: 0 };

  for (let i = 0; i < world.accounts.length; i += BATCH) {
    const batch = world.accounts.slice(i, i + BATCH);
    await sendMessages(
      producer,
      AccountProfileUpserted.topic,
      batch.map((account) => message(account.accountId, profileEnvelope(account, now))),
    );
    result.profiles += batch.length;
    options.onProgress?.(result);
  }

  const end = new Date(now.getTime() - 60 * 60 * 1000);
  let pending: OutgoingMessage[] = [];
  for (const account of world.accounts) {
    for (const past of accountHistory(random, world, account, { days: options.days, end })) {
      pending.push(message(account.accountId, historyEnvelope(past, options.hashPepper)));
    }
    if (pending.length >= BATCH) {
      await sendMessages(producer, TransactionAuthorizationRequested.topic, pending);
      result.transactions += pending.length;
      pending = [];
      options.onProgress?.(result);
    }
  }
  await sendMessages(producer, TransactionAuthorizationRequested.topic, pending);
  result.transactions += pending.length;
  options.onProgress?.(result);
  return result;
}

function message(key: string, envelope: Envelope<unknown>): OutgoingMessage {
  return { key, value: JSON.stringify(envelope), headers: eventHeaders(envelope) };
}
