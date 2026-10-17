import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  logCorrelation,
  startProducerSpan,
  traceparentOf,
  withConsumerSpan,
  withLogFields,
} from './index.js';

const INCOMING = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

describe('without a registered SDK', () => {
  it('carries the incoming traceparent through consume and publish unchanged', async () => {
    const seen = await withConsumerSpan('process t', INCOMING, {}, (tp) => Promise.resolve(tp));
    expect(seen).toBe(INCOMING);
    expect(startProducerSpan('publish t', INCOMING, {}).traceparent).toBe(INCOMING);
    expect(traceparentOf()).toBeUndefined();
  });
});

describe('with the SDK', () => {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });
  beforeEach(() => {
    exporter.reset();
  });

  it('chains publish -> consume -> publish in one trace (SPEC §10)', async () => {
    const published = startProducerSpan('publish payments.transactions.v1', INCOMING, {
      'messaging.destination.name': 'payments.transactions.v1',
    });
    published.span.end();
    expect(published.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));

    const downstream = await withConsumerSpan(
      'process payments.transactions.v1',
      published.traceparent,
      { 'messaging.consumer.group.name': 'fraud-rules' },
      // What the handler writes to its outbox: the active context, i.e. this consumer span.
      (tp) => Promise.resolve({ given: tp, active: traceparentOf() }),
    );
    expect(downstream.given).toBe(downstream.active);

    const [producer, consumer] = exporter.getFinishedSpans();
    expect(producer?.spanContext().traceId).toBe(TRACE_ID);
    expect(consumer?.spanContext().traceId).toBe(TRACE_ID);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
    expect(downstream.given).toContain(consumer?.spanContext().spanId);
  });

  it('marks a failed handler span as an error and rethrows', async () => {
    await expect(
      withConsumerSpan('process t', INCOMING, {}, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.events[0]?.name).toBe('exception');
  });

  it('adds traceId, correlationId and transactionId to log lines (log mixin)', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = createLogger({ service: 'svc', destination });

    logger.info('outside');
    await withConsumerSpan('process t', INCOMING, {}, () =>
      withLogFields({ correlationId: 'corr-1', transactionId: 'tx-1' }, async () => {
        await Promise.resolve(); // survives async hops
        logger.info('inside');
      }),
    );

    const [outside, inside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(outside).not.toHaveProperty('traceId');
    expect(inside).toMatchObject({
      service: 'svc',
      traceId: TRACE_ID,
      correlationId: 'corr-1',
      transactionId: 'tx-1',
      msg: 'inside',
    });
    expect(logCorrelation()).toEqual({});
  });
});
