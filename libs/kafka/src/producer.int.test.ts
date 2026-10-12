import { createEnvelope, EventHeaders, Topics, uuidv7 } from '@fraudstream/contracts';
import { readAll, startKafka, type TestKafka } from '@fraudstream/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eventHeaders } from './headers.js';
import { createProducer, sendMessages } from './producer.js';

let kafka: TestKafka;

beforeAll(async () => {
  kafka = await startKafka();
});

afterAll(async () => {
  await kafka.stop();
});

it('publishes with all seven standard headers (SPEC §4.2)', async () => {
  const envelope = createEnvelope({
    eventType: 'Test',
    eventVersion: 1,
    producer: 'test',
    correlationId: uuidv7(),
    causationId: uuidv7(),
    payload: { hello: 1 },
  });
  const headers = eventHeaders(envelope);
  const producer = createProducer(kafka.kafka);
  await producer.connect();
  await sendMessages(producer, Topics.transactions, [
    { key: 'acc_1', value: JSON.stringify(envelope), headers },
  ]);
  await producer.disconnect();

  const [message, ...rest] = await readAll(kafka.kafka, [Topics.transactions]);
  expect(rest).toEqual([]);
  expect(message?.key).toBe('acc_1');
  expect(message?.headers).toEqual(headers);
  expect(Object.keys(message?.headers ?? {}).sort()).toEqual(Object.values(EventHeaders).sort());
});
