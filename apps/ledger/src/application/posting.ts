import {
  FraudDecisionMade,
  LedgerEntriesPosted,
  TransactionAuthorizationRequested,
  uuidv7,
  type LedgerEntriesPostedV1,
  type LedgerEntry,
} from '@fraudstream/contracts';
import type { PoolClient } from '@fraudstream/db';
import { on, TransientError, type EventHandler } from '@fraudstream/kafka';
import { Counter, type Registry } from '@fraudstream/observability';
import type { OutboxWriter } from '@fraudstream/outbox';
import { balanceDeltas, buildJournal, type ApprovedTransaction } from '../domain/journal.js';
import { LedgerRepository } from '../infrastructure/db/ledger.repository.js';

export const PRODUCER = 'ledger';

export interface Posted {
  journalId: string;
  entries: LedgerEntry[];
  postedAt: Date;
}

/** Builds the published event; exported for contract tests (SPEC §13.3). */
export function toPostedEvent(tx: ApprovedTransaction, posted: Posted): LedgerEntriesPostedV1 {
  return {
    transactionId: tx.transactionId,
    accountId: tx.accountId,
    journalId: posted.journalId,
    entries: posted.entries,
    postedAt: posted.postedAt.toISOString(),
  };
}

/**
 * One journal, its entries and the balance updates, in the caller's DB transaction.
 * Returns null when the transaction already has a journal (redelivery, replay).
 */
export async function postApproval(
  db: PoolClient,
  repo: LedgerRepository,
  tx: ApprovedTransaction,
  now: Date = new Date(),
): Promise<Posted | null> {
  const journalId = uuidv7(now.getTime());
  if (!(await repo.insertJournal(db, journalId, tx.transactionId, now))) return null;
  const entries = buildJournal(tx);
  await repo.insertEntries(db, journalId, entries);
  for (const delta of balanceDeltas(entries)) await repo.applyDelta(db, delta);
  return { journalId, entries, postedAt: now };
}

export class Ledger {
  readonly repository: LedgerRepository;
  private readonly postings: Counter<'outcome'>;

  constructor(
    private readonly outbox: OutboxWriter,
    registry: Registry,
  ) {
    const conflicts = new Counter({
      name: 'ledger_balance_conflicts_total',
      help: 'Optimistic-locking version conflicts on balance updates',
      registers: [registry],
    });
    this.postings = new Counter({
      name: 'ledger_postings_total',
      help: 'Decisions handled by the ledger, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.repository = new LedgerRepository(() => {
      conflicts.inc();
    });
  }

  handlers(): EventHandler[] {
    const repo = this.repository;
    return [
      // Projection: the decision carries no amount or merchant (SPEC §4.9, design.md).
      on(TransactionAuthorizationRequested, async (envelope, ctx) => {
        await repo.upsertProjection(ctx.tx, envelope.payload);
      }),

      on(FraudDecisionMade, async (envelope, ctx) => {
        const { transactionId, decision } = envelope.payload;
        if (decision !== 'APPROVE') {
          this.postings.inc({ outcome: 'not-approved' });
          return; // REVIEW and DECLINE move no money (SPEC §6.7)
        }
        // Checked before the projection: a replay after the projection was purged is a no-op.
        if (await repo.journalExists(ctx.tx, transactionId)) {
          this.postings.inc({ outcome: 'duplicate' });
          return;
        }
        const projected = await repo.findProjection(ctx.tx, transactionId);
        if (!projected) {
          // Different topics are not ordered relative to each other: wait for the transaction.
          throw new TransientError(`transaction ${transactionId} not projected yet`);
        }
        const approved: ApprovedTransaction = { transactionId, ...projected };
        const posted = await postApproval(ctx.tx, repo, approved);
        if (!posted) {
          this.postings.inc({ outcome: 'duplicate' });
          return;
        }
        await this.outbox.write(ctx.tx, {
          topic: LedgerEntriesPosted.topic,
          key: approved.accountId,
          envelope: ctx.child({
            eventType: LedgerEntriesPosted.eventType,
            eventVersion: LedgerEntriesPosted.eventVersion,
            producer: PRODUCER,
            payload: toPostedEvent(approved, posted),
          }),
          traceparent: ctx.traceparent,
        });
        this.postings.inc({ outcome: 'posted' });
      }),
    ];
  }
}
