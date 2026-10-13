import {
  AccountId,
  CountryCode,
  CurrencyCode,
  DecimalString,
  DecisionBreakdown,
  FraudDecisionMadeV1,
  LedgerEntry,
  MaskedPan,
  UnitScore,
} from '@fraudstream/contracts';
import { z } from 'zod';
import { ALERT_STATUSES } from '../db/alerts.repository.js';

/**
 * Response shapes of the gateway (SPEC §6.8), published in the OpenAPI document so the
 * dashboard's client types are generated, not hand-written (SPEC §8.3).
 */
const Money = z.object({ value: DecimalString, currency: CurrencyCode });
const Timestamp = z.string().describe('ISO 8601, UTC');

export const Principal = z.object({
  userId: z.uuid(),
  email: z.string(),
  role: z.enum(['analyst', 'admin']),
});

export const LoginResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int(),
  user: Principal,
});

const AlertBase = z.object({
  alertId: z.uuid(),
  transactionId: z.uuid(),
  accountId: AccountId,
  decision: z.enum(['REVIEW', 'DECLINE']),
  finalScore: z.string().describe('numeric(5,4) as text, e.g. "0.6960"'),
  reasons: z.array(z.string()),
  status: z.enum(ALERT_STATUSES),
  assignedTo: z.uuid().nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});

export const AlertListItem = AlertBase.extend({
  amount: Money.nullable(),
  merchantName: z.string().nullable(),
  country: z.string().nullable(),
  firedRules: z.array(z.string()).describe('rule ids, e.g. R006'),
});

export const AlertPage = z.object({
  items: z.array(AlertListItem),
  nextCursor: z.string().nullable(),
});

export const AlertSnapshot = z.object({
  transaction: z.object({
    amount: Money,
    merchant: z.object({
      id: z.string(),
      name: z.string(),
      mcc: z.string(),
      country: CountryCode,
      city: z.string().optional(),
    }),
    maskedPan: MaskedPan,
    channel: z.string(),
    entryMode: z.string(),
    geo: z.object({ lat: z.number(), lon: z.number() }).optional(),
    requestedAt: Timestamp,
  }),
  decision: z.object({
    decision: z.enum(['REVIEW', 'DECLINE']),
    finalScore: UnitScore,
    components: z.object({ ruleScore: UnitScore.nullable(), anomalyScore: UnitScore.nullable() }),
    reasons: z.array(z.string()),
    partial: z.boolean(),
    decidedAt: Timestamp,
    latencyMs: z.number().int(),
    breakdown: DecisionBreakdown.nullable(),
  }),
});

export const AlertDetail = AlertBase.extend({ snapshot: AlertSnapshot });

export const TimelineItem = z.object({
  kind: z.enum(['DECISION', 'LEDGER']),
  transactionId: z.uuid(),
  occurredAt: Timestamp,
  amount: Money.nullable(),
  payload: z.union([
    FraudDecisionMadeV1,
    z.object({
      transactionId: z.string(),
      accountId: AccountId,
      journalId: z.uuid(),
      entries: z.array(LedgerEntry),
      postedAt: Timestamp,
    }),
  ]),
});

export const Timeline = z.object({ accountId: AccountId, items: z.array(TimelineItem) });

export const AccountView = z.object({
  accountId: AccountId,
  profile: z
    .object({
      homeCountry: z.string(),
      homeCity: z.string().nullable(),
      riskTier: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      creditLimit: DecimalString,
    })
    .nullable(),
  balance: z.object({ currency: z.string(), balance: z.string() }).nullable(),
  stats: z.object({
    transactions: z.number().int(),
    averageAmount: z.string().nullable(),
    approve: z.number().int(),
    review: z.number().int(),
    decline: z.number().int(),
    openAlerts: z.number().int(),
  }),
});

export const Summary = z.object({
  windowSeconds: z.number().int(),
  decisions: z.number().int(),
  transactionsPerSecond: z.number(),
  rates: z.object({ approve: z.number(), review: z.number(), decline: z.number() }),
  p95LatencyMs: z.number().nullable(),
});

export const LagResponse = z.object({
  items: z.array(
    z.object({
      group: z.string(),
      topic: z.string(),
      partition: z.number().int(),
      committed: z.string().nullable(),
      end: z.string(),
      lag: z.string(),
    }),
  ),
});

export const ReplayResponse = z.object({
  dryRun: z.boolean(),
  results: z.array(
    z.object({
      partition: z.number().int(),
      offset: z.string(),
      originalTopic: z.string().nullable(),
      reason: z.string().nullable(),
      replayed: z.boolean(),
    }),
  ),
});

/** Event payloads of `GET /v1/stream` (documented in the OpenAPI components). */
export const StreamAlert = AlertBase.pick({
  alertId: true,
  transactionId: true,
  accountId: true,
  decision: true,
  finalScore: true,
  status: true,
  assignedTo: true,
  createdAt: true,
});
export const StreamEvents = {
  'alert.created': StreamAlert,
  'alert.updated': StreamAlert,
  'decision.made': FraudDecisionMadeV1,
  'metrics.tick': Summary,
};
