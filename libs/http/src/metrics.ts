import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Histogram, type Registry } from '@fraudstream/observability';

/** Injection token of the service's Prometheus registry. */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/** `GET /metrics` in the Prometheus text format (SPEC §10). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}

const histograms = new WeakMap<Registry, Histogram<'method' | 'route' | 'status'>>();

function requestHistogram(registry: Registry): Histogram<'method' | 'route' | 'status'> {
  const existing = histograms.get(registry);
  if (existing) return existing;
  const histogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration by route template and status code',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  histograms.set(registry, histogram);
  return histogram;
}

type RoutedRequest = IncomingMessage & { route?: { path?: unknown }; baseUrl?: string };

/**
 * Express middleware recording `http_request_duration_seconds{method,route,status}` (SPEC
 * §10). The route label is the matched template (`/v1/transactions/:id`), never the raw URL,
 * so ids do not explode the label cardinality; unmatched requests are `unmatched`.
 */
export function httpMetrics(registry: Registry) {
  const histogram = requestHistogram(registry);
  return (req: RoutedRequest, res: ServerResponse, next: () => void): void => {
    const started = performance.now();
    res.once('finish', () => {
      const template = req.route?.path;
      const route = typeof template === 'string' ? `${req.baseUrl ?? ''}${template}` : 'unmatched';
      histogram.observe(
        { method: req.method ?? 'GET', route, status: String(res.statusCode) },
        (performance.now() - started) / 1000,
      );
    });
    next();
  };
}
