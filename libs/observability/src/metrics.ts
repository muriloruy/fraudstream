import { collectDefaultMetrics, Registry } from 'prom-client';

/** A Prometheus registry labelled with the service name, with Node runtime metrics. */
export function createMetricsRegistry(service: string, collectDefaults = true): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  if (collectDefaults) collectDefaultMetrics({ register: registry });
  return registry;
}

export { Counter, Gauge, Histogram, Registry } from 'prom-client';
