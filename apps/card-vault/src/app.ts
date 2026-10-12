import 'reflect-metadata';
import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPool, databaseIsReachable, type Pool } from '@fraudstream/db';
import {
  HealthController,
  ProblemDetailsFilter,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@fraudstream/http';
import { loggerOptions, type DestinationStream } from '@fraudstream/observability';
import helmet from 'helmet';
import { Logger, LoggerModule } from 'nestjs-pino';

import { VaultService } from './application/vault.service.js';
import type { VaultConfig } from './config/config.js';
import { CardsRepository } from './infrastructure/db/cards.repository.js';
import { VaultAuthGuard } from './infrastructure/http/auth.guard.js';
import { DB_POOL, VAULT_CONFIG, VAULT_SERVICE } from './infrastructure/http/tokens.js';
import { VaultController } from './infrastructure/http/vault.controller.js';

export const SERVICE_NAME = 'card-vault';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  static forRoot(config: VaultConfig, logDestination?: DestinationStream): DynamicModule {
    const options = loggerOptions({ service: SERVICE_NAME, level: config.logLevel });
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: logDestination ? [options, logDestination] : options,
        }),
      ],
      controllers: [VaultController, HealthController],
      providers: [
        { provide: VAULT_CONFIG, useValue: config },
        {
          provide: DB_POOL,
          useFactory: () =>
            createPool({ connectionString: config.databaseUrl, applicationName: SERVICE_NAME }),
        },
        {
          provide: VAULT_SERVICE,
          inject: [DB_POOL],
          useFactory: (pool: Pool) =>
            new VaultService(new CardsRepository(pool), config.keyring, config.hmacKey),
        },
        {
          provide: READINESS_CHECKS,
          inject: [DB_POOL],
          useFactory: (pool: Pool): ReadinessCheck[] => [
            { name: 'database', check: () => databaseIsReachable(pool) },
          ],
        },
        VaultAuthGuard,
      ],
    };
  }
}

/** Builds the HTTP app with the same hardening in production and in tests. */
export async function createApp(
  config: VaultConfig,
  logDestination?: DestinationStream,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, logDestination),
    { bufferLogs: true },
  );
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.use(helmet());
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
  return app;
}
