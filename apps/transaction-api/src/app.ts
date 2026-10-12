import 'reflect-metadata';
import {
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConsumerGroups, FraudDecisionMade, Topics } from '@fraudstream/contracts';
import { createPool, databaseIsReachable, type Pool } from '@fraudstream/db';
import {
  HealthController,
  ProblemDetailsFilter,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@fraudstream/http';
import {
  ConsumerRuntime,
  createKafka,
  createProducer,
  kafkaIsReachable,
  on,
  type Kafka,
  type Producer,
} from '@fraudstream/kafka';
import { loggerOptions, type DestinationStream } from '@fraudstream/observability';
import { OutboxWriter } from '@fraudstream/outbox';
import helmet from 'helmet';
import { Logger, LoggerModule } from 'nestjs-pino';
import { TransactionsService } from './application/transactions.service.js';
import type { ApiConfig } from './config/config.js';
import { ApiKeysRepository } from './infrastructure/db/api-keys.repository.js';
import { IdempotencyRepository } from './infrastructure/db/idempotency.repository.js';
import { TransactionsRepository } from './infrastructure/db/transactions.repository.js';
import { ApiKeyGuard } from './infrastructure/http/api-key.guard.js';
import {
  API_CONFIG,
  API_KEYS_REPOSITORY,
  DB_POOL,
  KAFKA,
  PRODUCER,
  STATUS_CONSUMER,
  TRANSACTIONS_REPOSITORY,
  TRANSACTIONS_SERVICE,
} from './infrastructure/http/tokens.js';
import { TransactionsController } from './infrastructure/http/transactions.controller.js';
import { VaultClient } from './infrastructure/vault/vault.client.js';

export const SERVICE_NAME = 'transaction-api';
const PARTITION_MAINTENANCE_MS = 6 * 60 * 60 * 1000;

@Module({})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private partitionTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transactions: TransactionsRepository,
    @Inject(PRODUCER) private readonly producer: Producer,
    @Inject(STATUS_CONSUMER) private readonly statusConsumer: ConsumerRuntime,
  ) {}

  static forRoot(config: ApiConfig, logDestination?: DestinationStream): DynamicModule {
    const options = loggerOptions({ service: SERVICE_NAME, level: config.logLevel });
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({ pinoHttp: logDestination ? [options, logDestination] : options }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'per-api-key', ttl: 60_000, limit: config.rateLimitPerMinute }],
          // Limits apply per API key, not per IP (SPEC §7).
          getTracker: (req: Record<string, unknown>) =>
            typeof req.apiKeyId === 'string' ? req.apiKeyId : 'anonymous',
        }),
      ],
      controllers: [TransactionsController, HealthController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        {
          provide: DB_POOL,
          useFactory: () =>
            createPool({ connectionString: config.databaseUrl, applicationName: SERVICE_NAME }),
        },
        {
          provide: KAFKA,
          useFactory: () => createKafka({ brokers: config.kafkaBrokers, clientId: SERVICE_NAME }),
        },
        {
          provide: PRODUCER,
          inject: [KAFKA],
          useFactory: (kafka: Kafka) => createProducer(kafka, { 'message.timeout.ms': 15_000 }),
        },
        {
          // The API owns payments.transactions, so it applies decisions to it itself
          // (SPEC §3.3 step 8), through the idempotent consumer runtime.
          provide: STATUS_CONSUMER,
          inject: [DB_POOL, KAFKA, PRODUCER, TRANSACTIONS_REPOSITORY],
          useFactory: (
            pool: Pool,
            kafka: Kafka,
            producer: Producer,
            transactions: TransactionsRepository,
          ) =>
            new ConsumerRuntime({
              kafka,
              pool,
              producer,
              group: ConsumerGroups.transactionApiStatus,
              schema: 'payments',
              handlers: [
                on(FraudDecisionMade, async (envelope, ctx) => {
                  await transactions.applyDecision(ctx.tx, envelope.payload);
                }),
              ],
            }),
        },
        {
          provide: TRANSACTIONS_REPOSITORY,
          inject: [DB_POOL],
          useFactory: (pool: Pool) => new TransactionsRepository(pool),
        },
        {
          provide: API_KEYS_REPOSITORY,
          inject: [DB_POOL],
          useFactory: (pool: Pool) => new ApiKeysRepository(pool),
        },
        {
          provide: TRANSACTIONS_SERVICE,
          inject: [DB_POOL, TRANSACTIONS_REPOSITORY],
          useFactory: (pool: Pool, transactions: TransactionsRepository) =>
            new TransactionsService(
              pool,
              new IdempotencyRepository(pool),
              transactions,
              new OutboxWriter('payments'),
              new VaultClient(config.vaultUrl, config.vaultServiceToken, config.vaultTimeoutMs),
              config.hashPepper,
            ),
        },
        {
          provide: READINESS_CHECKS,
          inject: [DB_POOL, KAFKA],
          useFactory: (pool: Pool, kafka: Kafka): ReadinessCheck[] => [
            { name: 'database', check: () => databaseIsReachable(pool) },
            { name: 'kafka', check: () => kafkaIsReachable(kafka, Topics.transactions) },
          ],
        },
        ApiKeyGuard,
      ],
    };
  }

  /**
   * Keeps monthly partitions ahead of time. Boot does not depend on the database: if it is
   * down, readiness reports it and the next maintenance run (every minute until the first
   * success, then every 6 h) creates the partitions.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.producer.connect();
    await this.statusConsumer.start();
    const run = async () => {
      const ok = await this.transactions.ensurePartitions().then(
        () => true,
        () => false,
      );
      this.partitionTimer = setTimeout(() => void run(), ok ? PARTITION_MAINTENANCE_MS : 60_000);
      this.partitionTimer.unref();
    };
    void run();
  }

  async onApplicationShutdown(): Promise<void> {
    clearTimeout(this.partitionTimer);
    await this.statusConsumer.stop();
    await this.producer.disconnect();
    await this.pool.end();
  }
}

/** Builds the HTTP app with the same hardening in production and in tests (SPEC §7). */
export async function createApp(
  config: ApiConfig,
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
  // Server-to-server API: CORS stays closed unless origins are explicitly allowed.
  if (config.corsOrigins.length > 0) app.enableCors({ origin: config.corsOrigins });
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
  return app;
}
