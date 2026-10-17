import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface TracingOptions {
  serviceName: string;
  /** Defaults to OTLP/HTTP (JSON) at OTEL_EXPORTER_OTLP_ENDPOINT (Jaeger, SPEC §10). */
  exporter?: SpanExporter;
}

const IGNORED_PATHS = new Set(['/metrics', '/health/live', '/health/ready']);

/**
 * Starts the OpenTelemetry SDK (M7 design): auto-instrumentation for http, express, pg and
 * NestJS, W3C trace context, OTLP export. Kafka spans are manual (libs/kafka, libs/outbox).
 * Probes and scrapes are not traced. Returns the shutdown function (flushes pending spans).
 */
export function startTracing(options: TracingOptions): () => Promise<void> {
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    traceExporter: options.exporter ?? new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => IGNORED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
  return () => sdk.shutdown();
}
