import type { ServiceDeps } from '@fraudstream/service-kit';
import { AlertsService } from './application/alerts.service.js';
import { AuthService } from './auth/auth.service.js';
import { TokenService } from './auth/tokens.js';
import type { GatewayConfig } from './config/config.js';
import { AlertsRepository } from './infrastructure/db/alerts.repository.js';
import { AuditRepository } from './infrastructure/db/audit.repository.js';
import { UsersRepository } from './infrastructure/db/users.repository.js';
import { EventBus } from './stream/event-bus.js';

/**
 * Composition root shared by the consumers (built by service-kit) and the HTTP controllers
 * (Nest DI): one pool, one producer, one event bus per process.
 */
export class Gateway {
  readonly tokens: TokenService;
  readonly auth: AuthService;
  readonly alerts: AlertsService;
  readonly alertsRepository = new AlertsRepository();
  readonly users = new UsersRepository();
  readonly audit = new AuditRepository();
  readonly bus = new EventBus();

  constructor(
    readonly config: GatewayConfig,
    readonly deps: ServiceDeps,
  ) {
    this.tokens = new TokenService(config.jwtSecret, config.accessTtlMs, config.streamSessionTtlMs);
    this.auth = new AuthService(
      deps.pool,
      this.users,
      this.audit,
      this.tokens,
      config.refreshTtlMs,
    );
    this.alerts = new AlertsService(
      deps.pool,
      this.alertsRepository,
      this.audit,
      deps.outbox,
      this.bus,
      config.decisionSampleRate,
    );
  }
}
