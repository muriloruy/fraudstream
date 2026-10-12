import { createServer } from 'node:net';
import { allTopics, type TopicSpec } from '@fraudstream/contracts';
import confluent from '@confluentinc/kafka-javascript';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// Uses the client directly (not @fraudstream/kafka) so that lib can depend on this one in tests.
type Kafka = KafkaJS.Kafka;

export interface TestKafka {
  container: StartedTestContainer;
  brokers: string[];
  /** A client for test assertions (consuming topics, admin calls). */
  kafka: Kafka;
  stop(): Promise<void>;
}

/**
 * A single-broker KRaft cluster (same image as the compose stack) with every catalogued
 * topic created at replication factor 1. The external listener is advertised on a fixed,
 * pre-allocated host port because clients must reach the address the broker advertises.
 */
export async function startKafka(topics: readonly TopicSpec[] = allTopics()): Promise<TestKafka> {
  const hostPort = await freePort();
  const container = await new GenericContainer('apache/kafka:4.1.0')
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:9092,EXTERNAL://localhost:${hostPort}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withExposedPorts({ container: 9094, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .start();

  const brokers = [`localhost:${hostPort}`];
  const kafka = new confluent.KafkaJS.Kafka({
    kafkaJS: { brokers, clientId: 'test', logLevel: confluent.KafkaJS.logLevel.WARN },
  });
  if (topics.length > 0) {
    const admin = kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: topics.map((t) => ({
          topic: t.name,
          numPartitions: t.partitions,
          replicationFactor: 1,
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
  return {
    container,
    brokers,
    kafka,
    async stop() {
      await container.stop();
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not allocate a port'));
      });
    });
  });
}
