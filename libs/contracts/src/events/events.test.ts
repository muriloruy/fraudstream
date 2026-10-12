import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOPIC_CATALOGUE } from '../topics.js';
import { EVENTS_V1, type EventTypeV1 } from './index.js';

const FIXTURES: Record<EventTypeV1, string> = {
  TransactionAuthorizationRequested: 'transaction-authorization-requested',
  FraudRulesEvaluated: 'fraud-rules-evaluated',
  AnomalyScored: 'anomaly-scored',
  FraudDecisionMade: 'fraud-decision-made',
  LedgerEntriesPosted: 'ledger-entries-posted',
  AccountProfileUpserted: 'account-profile-upserted',
  AnalystFeedbackRecorded: 'analyst-feedback-recorded',
};

type Json = Record<string, unknown>;

function fixture(type: EventTypeV1): Json {
  const url = new URL(`../../fixtures/${FIXTURES[type]}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Json;
}

function payloadOf(type: EventTypeV1): Json {
  return structuredClone(fixture(type).payload) as Json;
}

const eventTypes = Object.keys(EVENTS_V1) as EventTypeV1[];

describe('v1 event fixtures (SPEC §4.9 examples)', () => {
  it.each(eventTypes)('%s fixture parses as a full envelope', (type) => {
    const definition = EVENTS_V1[type];
    const raw = fixture(type);
    expect(raw.eventType).toBe(definition.eventType);
    expect(raw.eventVersion).toBe(definition.eventVersion);
    expect(definition.envelope.safeParse(raw).success).toBe(true);
  });

  it.each(eventTypes)('%s is published to a catalogued topic', (type) => {
    const names = TOPIC_CATALOGUE.map((t) => t.name);
    expect(names).toContain(EVENTS_V1[type].topic);
  });
});

describe('invalid payloads are rejected', () => {
  const cases: [EventTypeV1, string, (p: Json) => void][] = [
    ['FraudDecisionMade', 'decision outside the allowed set', (p) => (p.decision = 'MAYBE')],
    ['FraudDecisionMade', 'finalScore above 1', (p) => (p.finalScore = 1.2)],
    ['AnalystFeedbackRecorded', 'unknown verdict', (p) => (p.verdict = 'UNSURE')],
    ['AnalystFeedbackRecorded', 'empty note', (p) => (p.note = '')],
    ['TransactionAuthorizationRequested', 'unknown channel', (p) => (p.channel = 'PHONE')],
    [
      'TransactionAuthorizationRequested',
      'float amount',
      (p) => (p.amount = { value: 1250.9, currency: 'BRL' }),
    ],
    [
      'TransactionAuthorizationRequested',
      'three-decimal amount',
      (p) => (p.amount = { value: '10.123', currency: 'BRL' }),
    ],
    ['TransactionAuthorizationRequested', 'unmasked PAN', (p) => (p.maskedPan = '4111111111111111')],
    ['TransactionAuthorizationRequested', 'raw IP instead of hash', (p) => {
      p.device = { ipHash: '203.0.113.10', deviceIdHash: `sha256:${'b'.repeat(64)}` };
    }],
    ['FraudRulesEvaluated', 'malformed rule id', (p) => {
      p.firedRules = [{ ruleId: 'velocity', name: 'v', points: 1, details: {} }];
    }],
    ['LedgerEntriesPosted', 'unknown direction', (p) => {
      p.entries = [
        { ledgerAccount: 'customer:a', direction: 'DEBIT', amount: '1.00', currency: 'BRL' },
        { ledgerAccount: 'merchant:m', direction: 'SIDEWAYS', amount: '1.00', currency: 'BRL' },
      ];
    }],
    ['LedgerEntriesPosted', 'unbalanced journal', (p) => {
      p.entries = [
        { ledgerAccount: 'customer:a', direction: 'DEBIT', amount: '10.00', currency: 'BRL' },
        { ledgerAccount: 'merchant:m', direction: 'CREDIT', amount: '9.99', currency: 'BRL' },
      ];
    }],
    ['AccountProfileUpserted', 'unknown risk tier', (p) => (p.riskTier = 'EXTREME')],
  ]; // prettier-ignore

  it.each(cases)('%s: %s', (type, _label, mutate) => {
    const payload = payloadOf(type);
    mutate(payload);
    expect(EVENTS_V1[type].payload.safeParse(payload).success).toBe(false);
  });
});

describe('tolerant consumers (SPEC §4.10)', () => {
  it.each(eventTypes)('%s ignores and strips unknown fields', (type) => {
    const original = fixture(type);
    const raw: Json = {
      ...original,
      extraEnvelopeField: true,
      payload: { ...(original.payload as Json), foo: 'bar' },
    };
    const result = EVENTS_V1[type].envelope.safeParse(raw);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('extraEnvelopeField');
    expect(result.data?.payload).not.toHaveProperty('foo');
  });

  it('strips unknown nested fields', () => {
    const payload = payloadOf('TransactionAuthorizationRequested');
    payload.merchant = { ...(payload.merchant as Json), loyaltyTier: 'gold' };
    const result = EVENTS_V1.TransactionAuthorizationRequested.payload.parse(payload);
    expect(result.merchant).not.toHaveProperty('loyaltyTier');
  });
});

describe('ledger invariant', () => {
  it('does not throw on an invalid amount inside entries', () => {
    const payload = payloadOf('LedgerEntriesPosted');
    payload.entries = [
      { ledgerAccount: 'customer:a', direction: 'DEBIT', amount: '1.001', currency: 'BRL' },
      { ledgerAccount: 'merchant:m', direction: 'CREDIT', amount: '1.00', currency: 'BRL' },
    ];
    expect(EVENTS_V1.LedgerEntriesPosted.payload.safeParse(payload).success).toBe(false);
  });
});
