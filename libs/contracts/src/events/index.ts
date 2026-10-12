import { AccountProfileUpserted } from './account-profile-upserted.js';
import { AnalystFeedbackRecorded } from './analyst-feedback-recorded.js';
import { AnomalyScored } from './anomaly-scored.js';
import { FraudDecisionMade } from './fraud-decision-made.js';
import { FraudRulesEvaluated } from './fraud-rules-evaluated.js';
import { LedgerEntriesPosted } from './ledger-entries-posted.js';
import { TransactionAuthorizationRequested } from './transaction-authorization-requested.js';

export * from './account-profile-upserted.js';
export * from './analyst-feedback-recorded.js';
export * from './anomaly-scored.js';
export * from './fraud-decision-made.js';
export * from './fraud-rules-evaluated.js';
export * from './ledger-entries-posted.js';
export * from './transaction-authorization-requested.js';

/** Every v1 event definition, keyed by event type. */
export const EVENTS_V1 = {
  TransactionAuthorizationRequested,
  FraudRulesEvaluated,
  AnomalyScored,
  FraudDecisionMade,
  LedgerEntriesPosted,
  AccountProfileUpserted,
  AnalystFeedbackRecorded,
} as const;
export type EventTypeV1 = keyof typeof EVENTS_V1;
