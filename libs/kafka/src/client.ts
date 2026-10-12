import confluent from '@confluentinc/kafka-javascript';
import type { KafkaJS as KafkaJSTypes } from '@confluentinc/kafka-javascript';

/**
 * We use `@confluentinc/kafka-javascript` (librdkafka) through its KafkaJS-compatible API
 * (ADR-003). Every other module imports Kafka only through this file.
 */
export const { Kafka, CompressionTypes, logLevel } = confluent.KafkaJS;
export type Kafka = KafkaJSTypes.Kafka;
export type Admin = KafkaJSTypes.Admin;
export type Producer = KafkaJSTypes.Producer;
export type IHeaders = KafkaJSTypes.IHeaders;

export interface KafkaClientConfig {
  brokers: readonly string[];
  clientId: string;
}

export function createKafka(config: KafkaClientConfig): Kafka {
  return new Kafka({
    kafkaJS: {
      brokers: [...config.brokers],
      clientId: config.clientId,
      logLevel: logLevel.WARN,
    },
  });
}

/** Parses `KAFKA_BROKERS=host:port,host:port`. */
export function parseBrokers(value: string | undefined): string[] {
  const brokers = (value ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS is empty');
  return brokers;
}
