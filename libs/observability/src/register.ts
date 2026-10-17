/**
 * Preload entry of every service: `node --import @fraudstream/observability/register dist/main.js`.
 *
 * Services are ES modules, so `pg`, `express` and `http` are linked before the first line of
 * `main.ts` runs: an import at the top of `main.ts` would start the SDK too late to patch
 * them. `--import` runs this file first, installs the ESM loader hook of the
 * instrumentations and starts the SDK. Set OTEL_SDK_DISABLED=true to turn tracing off.
 */
import { register } from 'node:module';
import { startTracing } from './sdk.js';

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  // Compose sets OTEL_SERVICE_NAME; `pnpm start` / `pnpm dev` fall back to the package name.
  const serviceName =
    process.env.OTEL_SERVICE_NAME ??
    process.env.npm_package_name?.replace('@fraudstream/', '') ??
    'fraudstream';
  const shutdown = startTracing({ serviceName });
  // Flush the last spans on a graceful stop; the services exit on their own afterwards.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown().catch(() => undefined);
    });
  }
}
