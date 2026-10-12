import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEnvelope, FraudDecisionMade, type FraudDecisionMadeV1 } from './index.js';

// Mirrors the usage example in README.md so the documented API keeps compiling and working.
describe('README example', () => {
  it('builds, validates and reads back a decision event', () => {
    const consumedEvent = JSON.parse(
      readFileSync(new URL('../fixtures/anomaly-scored.json', import.meta.url), 'utf8'),
    ) as { eventId: string; correlationId: string };
    const transactionId = consumedEvent.correlationId;
    const payload: FraudDecisionMadeV1 = {
      transactionId,
      accountId: 'acc_000123',
      decision: 'APPROVE',
      finalScore: 0.12,
      components: { ruleScore: 0, anomalyScore: 0.3 },
      reasons: [],
      partial: false,
      decidedAt: new Date().toISOString(),
      latencyMs: 42,
    };

    // Producer: build and validate before writing to the outbox.
    const event = createEnvelope({
      eventType: FraudDecisionMade.eventType,
      eventVersion: FraudDecisionMade.eventVersion,
      producer: 'decision-engine',
      correlationId: transactionId,
      causationId: consumedEvent.eventId,
      payload,
    });
    FraudDecisionMade.envelope.parse(event);

    // Consumer: unknown fields are stripped, never rejected.
    const message = { value: JSON.stringify({ ...event, addedLater: true }) };
    const decision = FraudDecisionMade.envelope.parse(JSON.parse(message.value));

    expect(decision.payload.decision).toBe('APPROVE');
    expect(decision.causationId).toBe(consumedEvent.eventId);
    expect(decision).not.toHaveProperty('addedLater');
  });
});
