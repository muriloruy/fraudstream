import {
  context,
  createContextKey,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

/**
 * W3C trace context over Kafka headers (SPEC §10). The propagator is used directly instead
 * of the global API one: without a registered SDK (unit tests, OTEL_SDK_DISABLED) the global
 * propagator is a no-op, while this keeps carrying the incoming `traceparent` through every
 * hop, exactly as before tracing existed.
 */
const w3c = new W3CTraceContextPropagator();
const TRACER = 'fraudstream';

// Keys are the propagator's own header names (`traceparent`, `tracestate`), not input.
type Carrier = Map<string, string>;
const setter = {
  set: (carrier: Carrier, key: string, value: string) => {
    carrier.set(key, value);
  },
};
const getter = {
  get: (carrier: Carrier, key: string) => carrier.get(key),
  keys: (carrier: Carrier) => [...carrier.keys()],
};

/** The `traceparent` of `ctx` (default: the active context), if it holds a valid span. */
export function traceparentOf(ctx: Context = context.active()): string | undefined {
  const carrier: Carrier = new Map();
  w3c.inject(ctx, carrier, setter);
  return carrier.get('traceparent');
}

/** The context of a remote `traceparent` (a Kafka header), or the root context. */
export function contextFrom(traceparent: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return w3c.extract(ROOT_CONTEXT, new Map([['traceparent', traceparent]]), getter);
}

/** The trace id of the active span, for log correlation. */
export function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const id = span?.spanContext().traceId;
  return id && id !== '00000000000000000000000000000000' ? id : undefined;
}

export interface LogFields {
  correlationId?: string;
  transactionId?: string;
}

const LOG_FIELDS = createContextKey('fraudstream.log-fields');

/** Runs `fn` with fields every log line emitted inside it carries (SPEC §10 logs). */
export function withLogFields<T>(fields: LogFields, fn: () => T): T {
  const merged = { ...logFields(), ...fields };
  return context.with(context.active().setValue(LOG_FIELDS, merged), fn);
}

function logFields(): LogFields {
  return (context.active().getValue(LOG_FIELDS) as LogFields | undefined) ?? {};
}

/**
 * pino `mixin`: adds `traceId` of the active span and the correlation fields set with
 * `withLogFields` to every line. Empty outside a span or message.
 */
export function logCorrelation(): LogFields & { traceId?: string } {
  const traceId = activeTraceId();
  return { ...logFields(), ...(traceId ? { traceId } : {}) };
}

/**
 * Runs `fn` inside a CONSUMER span that continues the trace of the consumed message, so the
 * handler's DB spans and the events it writes belong to that trace. `fn` receives the
 * span's own `traceparent`, to put on what the handler publishes.
 */
export async function withConsumerSpan<T>(
  name: string,
  traceparent: string | undefined,
  attributes: Attributes,
  fn: (traceparent: string | undefined) => Promise<T>,
): Promise<T> {
  const parent = contextFrom(traceparent);
  const span = trace
    .getTracer(TRACER)
    .startSpan(name, { kind: SpanKind.CONSUMER, attributes }, parent);
  const ctx = trace.setSpan(parent, span);
  try {
    return await context.with(ctx, () => fn(traceparentOf(ctx)));
  } catch (error) {
    recordError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Starts a PRODUCER span for publishing a message whose stored `traceparent` points at the
 * span that wrote it (outbox); returns the span and the `traceparent` to send instead, so
 * the consumer becomes a child of the publish.
 */
export function startProducerSpan(
  name: string,
  traceparent: string | undefined,
  attributes: Attributes,
): { span: Span; traceparent: string | undefined } {
  const parent = contextFrom(traceparent);
  const span = trace
    .getTracer(TRACER)
    .startSpan(name, { kind: SpanKind.PRODUCER, attributes }, parent);
  return { span, traceparent: traceparentOf(trace.setSpan(parent, span)) ?? traceparent };
}

export function recordError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export type { Span };
