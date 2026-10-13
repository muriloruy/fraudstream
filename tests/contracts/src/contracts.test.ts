import {
  AnalystFeedbackRecorded,
  AnomalyScored,
  createEnvelope,
  FraudDecisionMade,
  FraudRulesEvaluated,
  LedgerEntriesPosted,
  TransactionAuthorizationRequested,
  uuidv7,
  type Envelope,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { decodeEvent, type EventDefinition } from '@fraudstream/kafka';
import * as gateway from '@fraudstream/alerts-gateway/contract';
import * as scorer from '@fraudstream/anomaly-scorer/contract';
import * as decision from '@fraudstream/decision-engine/contract';
import * as rules from '@fraudstream/fraud-rules/contract';
import * as ledger from '@fraudstream/ledger/contract';
import * as api from '@fraudstream/transaction-api/contract';
import { describe, expect, it } from 'vitest';

/**
 * SPEC §13.3: every producer's real event builder, fed edge cases, must produce messages the
 * consumers of that topic accept. Messages go through JSON (the wire format) and are decoded
 * with `decodeEvent`, exactly as the consumer runtime does; a schema change that breaks a
 * consumer fails here.
 */
function onTheWire<P>(producer: string, def: EventDefinition<P>, payload: P): string {
  const envelope = createEnvelope({
    eventType: def.eventType,
    eventVersion: def.eventVersion,
    producer,
    correlationId: crypto.randomUUID(),
    causationId: uuidv7(),
    payload,
  });
  return JSON.stringify(envelope);
}

function consume(value: string, definitions: readonly EventDefinition[]): Envelope<unknown> {
  return decodeEvent(value, definitions).envelope;
}

// Consumers per topic (SPEC §3.2): who decodes what.
const CONSUMES = {
  'fraud-rules': [TransactionAuthorizationRequested],
  'anomaly-scorer': [TransactionAuthorizationRequested],
  'decision-engine': [FraudRulesEvaluated, AnomalyScored],
  'transaction-api': [FraudDecisionMade],
  'alerts-gateway': [FraudDecisionMade, LedgerEntriesPosted],
  'anomaly-scorer (feedback)': [AnalystFeedbackRecorded],
} as const satisfies Record<string, readonly EventDefinition[]>;

const PEPPER = 'contract-test-pepper-of-sufficient-length';

const requests = {
  ecommerce: {
    accountId: 'acc_contract',
    card: { pan: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' },
    amount: { value: '1000000.00', currency: 'BRL' },
    merchant: { id: 'mer_1', name: 'Loja', mcc: '5732', country: 'BR', city: 'São Paulo' },
    channel: 'ECOMMERCE',
    entryMode: 'CARD_NOT_PRESENT',
    device: { ip: '2001:db8::1', deviceId: 'device-1' },
    geo: { lat: -23.55, lon: -46.63 },
  },
  posWithoutGeo: {
    accountId: 'acc-2',
    card: { pan: '5555555555554444', expiryMonth: 1, expiryYear: 2031, cvv: '9999' },
    amount: { value: '0.01', currency: 'USD' },
    merchant: { id: 'mer-blocked', name: 'Casino', mcc: '7995', country: 'US', city: 'Reno' },
    channel: 'POS',
    entryMode: 'CHIP',
    device: { ip: '198.51.100.7', deviceId: 'pos-terminal-9' },
  },
};

function authorizationEvents(): TransactionAuthorizationRequestedV1[] {
  return Object.values(requests).map((raw, i) =>
    api.toAuthorizationEvent(
      api.AuthorizationRequest.parse(raw),
      {
        cardToken: `tok_${'a1B2'.repeat(6)}`,
        maskedPan: `${raw.card.pan.slice(0, 6)}******${raw.card.pan.slice(-4)}`,
      },
      uuidv7(),
      new Date(Date.UTC(2026, 9, 12, 3 + i, 4, 5, 678)),
      PEPPER,
    ),
  );
}

describe('payments.transactions.v1 (transaction-api → fraud-rules, anomaly-scorer)', () => {
  it.each(Object.keys(requests))(
    '%s is accepted by every consumer and carries no PAN or CVV',
    (name) => {
      const index = Object.keys(requests).indexOf(name);
      const event = authorizationEvents()[index];
      if (!event) throw new Error('fixture missing');
      const wire = onTheWire('transaction-api', TransactionAuthorizationRequested, event);
      for (const consumer of ['fraud-rules', 'anomaly-scorer'] as const) {
        expect(consume(wire, CONSUMES[consumer]).payload).toEqual(event);
      }
      const raw = Object.values(requests)[index];
      expect(wire).not.toContain(raw?.card.pan);
      expect(wire).not.toMatch(/cvv/i);
    },
  );
});

describe('fraud.rule-results.v1 (fraud-rules → decision-engine)', () => {
  const ruleset = rules.loadRuleset();
  const quiet: rules.RuleContext = {
    countInVelocityWindow: 0,
    sumInAmountWindowCents: 0n,
    smallInTestingWindow: 0,
    historyCount: 0,
    historySumCents: 0n,
    last: null,
    knownMerchant: true,
    blocklistHits: [],
    profile: null,
  };
  const everythingFires: rules.RuleContext = {
    countInVelocityWindow: 50,
    sumInAmountWindowCents: 10_000_000_000n,
    smallInTestingWindow: 10,
    historyCount: 30,
    historySumCents: 3_000n,
    last: { country: 'JP', lat: 35.68, lon: 139.69, at: new Date(Date.UTC(2026, 9, 12, 2)) },
    knownMerchant: false,
    blocklistHits: ['MCC:7995', 'MERCHANT:mer-blocked'],
    profile: { homeCountry: 'AR', creditLimitCents: 100n },
  };

  it.each([
    ['no rule fires', quiet],
    ['every rule fires, hard decline', everythingFires],
  ])('%s', (_name, context) => {
    for (const tx of authorizationEvents()) {
      const evaluation = rules.evaluate(rules.toFacts(tx), context, ruleset);
      const result = rules.toResult(tx, ruleset, evaluation, new Date());
      const decoded = consume(
        onTheWire(rules.PRODUCER, FraudRulesEvaluated, result),
        CONSUMES['decision-engine'],
      );
      expect(decoded.payload).toEqual(result);
    }
  });

  it('the hard-decline fixture really exercises fired rules', () => {
    const [tx] = authorizationEvents();
    if (!tx) throw new Error('fixture missing');
    const evaluation = rules.evaluate(rules.toFacts(tx), everythingFires, ruleset);
    expect(evaluation.firedRules.length).toBeGreaterThan(5);
  });
});

describe('fraud.scores.v1 (anomaly-scorer → decision-engine)', () => {
  it('cold start, trusted baseline and an extreme spike are all accepted', () => {
    const [tx] = authorizationEvents();
    if (!tx) throw new Error('fixture missing');
    let baseline: scorer.Baseline | null = null;
    const scores = [scorer.score(baseline, 'HIGH', scorer.toObservation(tx, true))];
    for (let i = 0; i < 12; i++) {
      const obs = {
        amount: 50,
        at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        hour: 12,
        newMerchant: false,
      };
      baseline = scorer.update(baseline, 'LOW', obs, 0.1);
    }
    scores.push(scorer.score(baseline, 'LOW', scorer.toObservation(tx, true))); // 1,000,000.00 against a 50.00 habit
    for (const s of scores) {
      const scored = scorer.toScored(tx, s, new Date());
      const decoded = consume(
        onTheWire(scorer.PRODUCER, AnomalyScored, scored),
        CONSUMES['decision-engine'],
      );
      expect(decoded.payload).toEqual(scored);
    }
    expect(scores[1]?.anomalyScore).toBeGreaterThan(0.99);
  });
});

describe('fraud.decisions.v1 (decision-engine → transaction-api)', () => {
  const cfg = { ...decision.DEFAULT_FUSION, approveBelow: 0.4, declineFrom: 0.75 };
  const ruleParts = [
    null,
    { ruleScore: 0, hardDecline: false, firedRules: [] },
    { ruleScore: 1, hardDecline: true, firedRules: [{ ruleId: 'R005', name: 'blocklist' }] },
  ];
  const scoreParts = [
    null,
    {
      anomalyScore: 0.9999,
      baselineSampleSize: 40,
      features: { amountZ: 12.5, interArrivalZ: -6, newMerchant: true, hourOfDayDeviation: 1 },
    },
  ];

  it('every combination of parts, including timeouts with one part, is accepted', () => {
    const decided = new Date();
    for (const r of ruleParts) {
      for (const s of scoreParts) {
        if (!r && !s) continue;
        const outcome = decision.decide(r, s, cfg);
        for (const requestedAt of [undefined, new Date(decided.getTime() - 180).toISOString()]) {
          const event = decision.toDecisionEvent(
            uuidv7(),
            'acc_contract',
            outcome,
            decided,
            requestedAt,
          );
          const decoded = consume(
            onTheWire(decision.PRODUCER, FraudDecisionMade, event),
            CONSUMES['transaction-api'],
          );
          expect(decoded.payload).toEqual(event);
        }
      }
    }
  });
});

describe('ledger.entries.v1 (ledger → alerts-gateway)', () => {
  it.each(['0.01', '1250.9', '1000000.00'])('a journal of %s is accepted', (amount) => {
    const tx = {
      transactionId: uuidv7(),
      accountId: 'acc_contract',
      merchantId: 'mer-1',
      amount,
      currency: 'BRL',
    };
    const event = ledger.toPostedEvent(tx, {
      journalId: uuidv7(),
      entries: ledger.buildJournal(tx),
      postedAt: new Date(),
    });
    const decoded = consume(
      onTheWire(ledger.PRODUCER, LedgerEntriesPosted, event),
      CONSUMES['alerts-gateway'],
    );
    expect(decoded.payload).toEqual(event);
  });
});

describe('fraud.analyst-feedback.v1 (alerts-gateway → anomaly-scorer)', () => {
  it.each(['CONFIRMED_FRAUD', 'LEGITIMATE'] as const)('a %s resolution is accepted', (verdict) => {
    const alert = {
      alertId: crypto.randomUUID(),
      transactionId: uuidv7(),
      accountId: 'acc_contract',
    };
    const event = gateway.toFeedbackEvent(
      alert,
      verdict,
      crypto.randomUUID(),
      'x'.repeat(2000),
      new Date(),
    );
    const decoded = consume(
      onTheWire(gateway.PRODUCER, AnalystFeedbackRecorded, event),
      CONSUMES['anomaly-scorer (feedback)'],
    );
    expect(decoded.payload).toEqual(event);
  });
});
