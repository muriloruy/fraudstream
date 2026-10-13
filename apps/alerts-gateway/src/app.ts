import { ThrottlerModule } from '@nestjs/throttler';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ConsumerGroups, Topics } from '@fraudstream/contracts';
import {
  createConsumerService,
  SERVICE_DEPS,
  type ConsumerServiceOptions,
  type ServiceDeps,
} from '@fraudstream/service-kit';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { GatewayConfig } from './config/config.js';
import { Gateway } from './gateway.js';
import { AdminController } from './infrastructure/http/admin.controller.js';
import { AlertsController } from './infrastructure/http/alerts.controller.js';
import { AuthController } from './infrastructure/http/auth.controller.js';
import { AccessGuard } from './infrastructure/http/auth.guard.js';
import { buildOpenApi } from './infrastructure/http/openapi.js';
import { StreamController } from './infrastructure/http/stream.controller.js';
import { GATEWAY, TOKENS } from './infrastructure/http/tokens.js';

export const SERVICE_NAME = 'alerts-gateway';
const HOUR_MS = 60 * 60 * 1000;
/** Window of the metrics.tick pushed to dashboards every 2 s. */
const TICK_WINDOW_SECONDS = 60;

export async function createApp(
  config: GatewayConfig,
  extra: Partial<ConsumerServiceOptions> = {},
) {
  let gateway: Gateway | undefined;
  const gatewayFor = (deps: ServiceDeps) => (gateway ??= new Gateway(config, deps));

  const app = await createConsumerService({
    service: SERVICE_NAME,
    schema: 'alerts',
    config,
    readinessTopic: Topics.decisions,
    consumers: (deps) => [
      {
        group: ConsumerGroups.alertsGateway,
        handlers: gatewayFor(deps).alerts.handlers(),
        // accounts.profiles.v1 is compacted: a tombstone removes the profile.
        onTombstone: (accountId, tx) =>
          gatewayFor(deps).alertsRepository.deleteProfile(tx, accountId),
      },
    ],
    jobs: (deps) => [
      {
        name: 'metrics-tick',
        intervalMs: config.metricsTickMs,
        run: async () => {
          const g = gatewayFor(deps);
          g.bus.publish('metrics.tick', await g.alerts.summary(TICK_WINDOW_SECONDS));
        },
      },
      {
        name: 'purge',
        intervalMs: HOUR_MS,
        run: async () => {
          const g = gatewayFor(deps);
          await g.alertsRepository.purge(deps.pool, config.projectionRetentionMs);
          await g.users.purgeExpired(deps.pool);
        },
      },
    ],
    http: {
      imports: [
        ThrottlerModule.forRoot({
          // Applied to POST /auth/login only (ThrottlerGuard is not global): 10/min per IP.
          throttlers: [{ name: 'login', ttl: 60_000, limit: config.loginRateLimitPerMinute }],
          getTracker: (req: Record<string, unknown>) =>
            typeof req.ip === 'string' ? req.ip : 'unknown',
        }),
      ],
      controllers: [AuthController, AlertsController, StreamController, AdminController],
      providers: [
        { provide: GATEWAY, inject: [SERVICE_DEPS], useFactory: gatewayFor },
        { provide: TOKENS, inject: [GATEWAY], useFactory: (g: Gateway) => g.tokens },
        AccessGuard,
      ],
    },
    ...extra,
  });
  app.use(helmet());
  app.use(cookieParser());
  // Browser API with cookies: explicit allow-list only, credentials allowed for those origins.
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useBodyParser('json', { limit: '16kb' });
  SwaggerModule.setup('docs', app, buildOpenApi() as unknown as OpenAPIObject, {
    jsonDocumentUrl: 'docs-json',
  });
  return app;
}

/** The composition root of a running app (tests use it to reach the event bus). */
export const gatewayOf = (app: Awaited<ReturnType<typeof createApp>>): Gateway => app.get(GATEWAY);
