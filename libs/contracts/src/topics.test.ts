import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allTopics,
  ConsumerGroups,
  dlqTopic,
  FRAUD_FLOW_PARTITIONS,
  renderTopicsConf,
  retryTopic,
  TOPIC_CATALOGUE,
  Topics,
} from './topics.js';

const DAY = 86_400_000;
const byName = new Map(allTopics().map((t) => [t.name, t]));

describe('topic catalogue (SPEC §4.1)', () => {
  it('matches infra/kafka/topics.conf (run `pnpm topics:generate` if this fails)', () => {
    const conf = readFileSync(new URL('../../../infra/kafka/topics.conf', import.meta.url), 'utf8');
    expect(conf).toBe(renderTopicsConf());
  });

  it('co-partitions all fraud-flow topics with 12 partitions (ADR-002)', () => {
    for (const name of [
      Topics.transactions,
      Topics.accountProfiles,
      Topics.ruleResults,
      Topics.scores,
      Topics.decisions,
      Topics.ledgerEntries,
    ]) {
      expect(byName.get(name)?.partitions, name).toBe(FRAUD_FLOW_PARTITIONS);
    }
    expect(byName.get(Topics.analystFeedback)?.partitions).toBe(6);
  });

  it('uses the retention and cleanup policies of SPEC §4.1', () => {
    expect(byName.get(Topics.accountProfiles)?.cleanupPolicy).toBe('compact');
    expect(byName.get(Topics.transactions)?.retentionMs).toBe(7 * DAY);
    expect(byName.get(Topics.ruleResults)?.retentionMs).toBe(3 * DAY);
    expect(byName.get(Topics.scores)?.retentionMs).toBe(3 * DAY);
    expect(byName.get(Topics.decisions)?.retentionMs).toBe(30 * DAY);
    expect(byName.get(Topics.ledgerEntries)?.retentionMs).toBe(30 * DAY);
    expect(byName.get(Topics.analystFeedback)?.retentionMs).toBe(30 * DAY);
  });

  it('declares a retry and a DLQ topic for every (topic, group) pair', () => {
    for (const source of TOPIC_CATALOGUE) {
      for (const group of source.consumerGroups) {
        const retry = byName.get(retryTopic(source.name, group));
        const dlq = byName.get(dlqTopic(source.name, group));
        expect(retry, `${source.name}/${group} retry`).toMatchObject({
          partitions: source.partitions,
          retentionMs: DAY,
        });
        expect(dlq, `${source.name}/${group} dlq`).toMatchObject({
          partitions: 3,
          retentionMs: 30 * DAY,
        });
      }
    }
    expect(byName.has('payments.transactions.v1.fraud-rules.dlq')).toBe(true);
  });

  it('wires the consumer groups of SPEC §4.1', () => {
    const groupsOf = (name: string) => TOPIC_CATALOGUE.find((t) => t.name === name)?.consumerGroups;
    expect(groupsOf(Topics.decisions)).toEqual([
      ConsumerGroups.ledger,
      ConsumerGroups.alertsGateway,
      ConsumerGroups.transactionApiStatus,
    ]);
    expect(groupsOf(Topics.analystFeedback)).toEqual([ConsumerGroups.anomalyScorer]);
  });

  it('has no duplicate topic names', () => {
    const names = allTopics().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
