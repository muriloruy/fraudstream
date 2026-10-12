import type { TopicSpec } from '@fraudstream/contracts';
import type { Kafka } from './client.js';

/** Creates the given topics if missing, with explicit config (no broker auto-create, SPEC §4.1). */
export async function ensureTopics(
  kafka: Kafka,
  topics: readonly TopicSpec[],
  replicationFactor: number,
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((t) => !existing.has(t.name));
    if (missing.length === 0) return;
    await admin.createTopics({
      topics: missing.map((t) => ({
        topic: t.name,
        numPartitions: t.partitions,
        replicationFactor,
        configEntries: [
          { name: 'cleanup.policy', value: t.cleanupPolicy },
          ...(t.retentionMs === null
            ? []
            : [{ name: 'retention.ms', value: String(t.retentionMs) }]),
        ],
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

/** Readiness probe: true when the cluster answers a metadata request for `topic` in time. */
export async function kafkaIsReachable(
  kafka: Kafka,
  topic: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const admin = kafka.admin();
  try {
    await withTimeout(admin.connect(), timeoutMs);
    await withTimeout(admin.fetchTopicMetadata({ topics: [topic], timeout: timeoutMs }), timeoutMs);
    return true;
  } catch {
    return false;
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
