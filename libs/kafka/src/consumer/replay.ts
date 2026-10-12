import { DlqHeaders, RetryHeaders } from '@fraudstream/contracts';
import type { Kafka, Producer } from '../client.js';
import { normalizeHeaders, type MessageHeaders } from './context.js';

export interface DlqMessage {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: MessageHeaders;
}

export interface ReplayOptions {
  kafka: Kafka;
  producer: Producer;
  /** A `<topic>.<group>.dlq` topic. */
  dlqTopic: string;
  /** Inclusive offset range, applied to every partition unless `partition` is given. */
  from: bigint;
  to: bigint;
  partition?: number;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface ReplayResult {
  partition: number;
  offset: string;
  originalTopic: string | null;
  reason: string | null;
  replayed: boolean;
}

const STRIPPED = new Set<string>([
  ...Object.values(DlqHeaders),
  RetryHeaders.retryCount,
  RetryHeaders.retryAfter,
]);

/**
 * Republishes DLQ messages to their original topic with their original key, value and
 * headers (diagnostic headers removed, `replayed-at` added). Safe to run more than once:
 * consumers are idempotent by `event-id` (SPEC §4.4, §4.6).
 */
export async function replayDlq(options: ReplayOptions): Promise<ReplayResult[]> {
  const messages = (await readDlq(options)).filter(
    (m) =>
      (options.partition === undefined || m.partition === options.partition) &&
      BigInt(m.offset) >= options.from &&
      BigInt(m.offset) <= options.to,
  );
  const results: ReplayResult[] = [];
  for (const m of messages) {
    const originalTopic = m.headers[DlqHeaders.originalTopic] ?? null;
    const result: ReplayResult = {
      partition: m.partition,
      offset: m.offset,
      originalTopic,
      reason: m.headers[DlqHeaders.reason] ?? null,
      replayed: false,
    };
    if (!options.dryRun && originalTopic) {
      const headers = Object.fromEntries(
        Object.entries(m.headers).filter(([name]) => !STRIPPED.has(name)),
      );
      await options.producer.send({
        topic: originalTopic,
        messages: [
          {
            key: m.key,
            value: m.value,
            headers: { ...headers, 'replayed-at': new Date().toISOString() },
          },
        ],
      });
      result.replayed = true;
    }
    results.push(result);
  }
  return results;
}

/** Reads the whole DLQ topic with a throwaway, non-committing consumer. */
async function readDlq(options: ReplayOptions): Promise<DlqMessage[]> {
  const admin = options.kafka.admin();
  await admin.connect();
  const remaining = new Map<number, bigint>();
  try {
    for (const p of await admin.fetchTopicOffsets(options.dlqTopic)) {
      if (BigInt(p.high) > BigInt(p.low)) remaining.set(p.partition, BigInt(p.high));
    }
  } finally {
    await admin.disconnect();
  }
  if (remaining.size === 0) return [];

  const consumer = options.kafka.consumer({
    kafkaJS: {
      groupId: `dlq-replay-${String(Date.now())}-${String(Math.random()).slice(2)}`,
      fromBeginning: true,
      autoCommit: false,
    },
  });
  const messages: DlqMessage[] = [];
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [options.dlqTopic] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out reading ${options.dlqTopic}`));
      }, options.timeoutMs ?? 30_000);
      void consumer.run({
        eachMessage: ({ partition, message }) => {
          messages.push({
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value: message.value?.toString() ?? null,
            headers: normalizeHeaders(message.headers),
          });
          const high = remaining.get(partition);
          if (high !== undefined && BigInt(message.offset) + 1n >= high)
            remaining.delete(partition);
          if (remaining.size === 0) {
            clearTimeout(timer);
            resolve();
          }
          return Promise.resolve();
        },
      });
    });
  } finally {
    await consumer.disconnect();
  }
  return messages.sort(
    (a, b) => a.partition - b.partition || Number(BigInt(a.offset) - BigInt(b.offset)),
  );
}
