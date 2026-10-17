import 'reflect-metadata';
import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPool, databaseIsReachable, type Pool, type PoolClient } from '@fraudstream/db';
import {
  HealthController,
  httpMetrics,
  METRICS_REGISTRY,
  MetricsController,
  ProblemDetailsFilter,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@fraudstream/http';
import {
  ConsumerRuntime,
  createKafka,
  createProducer,
  kafkaIsReachable,
  type EventHandler,
  type Kafka,
  type Producer,
} from '@fraudstream/kafka';
import {
  createLogger,
  createMetricsRegistry,
  loggerOptions,
  type DestinationStream,
  type Logger,
  type Registry,
} from '@fraudstream/observability';
import { createRelayMetrics, OutboxRelay, OutboxWriter } from '@fraudstream/outbox';
import { Logger as NestPinoLogger, LoggerModule } from 'nestjs-pino';
import { JobRunner, type Job } from './jobs.js';

export interface ServiceConfig {
  databaseUrl: string;
  kafkaBrokers: string[];
  logLevel: string;
}

/** Everything a handler or job of a consumer service may need. */
export interface ServiceDeps {
  service: string;
  schema: string;
  pool: Pool;
  kafka: Kafka;
  producer: Producer;
  outbox: OutboxWriter;
  registry: Registry;
  logger: Logger;
}

export interface ConsumerSpec {
  group: string;
  handlers: readonly EventHandler[];
  onTombstone?: (key: string, tx: PoolClient, topic: string) => Promise<void>;
}

export interface ConsumerServiceOptions {
  service: string;
  /** The service's DB schema: processed_events, outbox and its own tables. */
  schema: string;
  config: ServiceConfig;
  consumers: (deps: ServiceDeps) => readonly ConsumerSpec[];
  jobs?: (deps: ServiceDeps) => readonly Job[];
  /** Topic probed by the readiness check. */
  readinessTopic: string;
  logDestination?: DestinationStream;
  /** Extra overrides for every consumer runtime (tests use shorter retry delays). */
  runtimeOverrides?: Partial<ConstructorParameters<typeof ConsumerRuntime>[0]>;
  /**
   * HTTP surface of services that also serve requests (alerts-gateway). Providers can inject
   * `SERVICE_DEPS` to share the pool, producer and outbox with the consumers.
   */
  http?: Pick<ModuleMetadata, 'imports' | 'controllers' | 'providers'>;
}

/** Injection token of the `ServiceDeps` of a consumer service. */
export const SERVICE_DEPS = Symbol('SERVICE_DEPS');
const DEPS = SERVICE_DEPS;
const OPTIONS = Symbol('SERVICE_OPTIONS');

/**
 * Starts, in order: producer, embedded outbox relay, jobs, consumers. Stops in reverse, so the
 * last messages processed still get their outbox events published before the process exits.
 */
class ServiceLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly runtimes: ConsumerRuntime[];
  private readonly relay: OutboxRelay;
  private readonly jobs: JobRunner;

  constructor(
    private readonly deps: ServiceDeps,
    options: ConsumerServiceOptions,
  ) {
    this.runtimes = options.consumers(deps).map(
      (spec) =>
        new ConsumerRuntime({
          kafka: deps.kafka,
          pool: deps.pool,
          producer: deps.producer,
          schema: deps.schema,
          group: spec.group,
          handlers: spec.handlers,
          ...(spec.onTombstone ? { onTombstone: spec.onTombstone } : {}),
          registry: deps.registry,
          logger: deps.logger,
          ...options.runtimeOverrides,
        }),
    );
    this.relay = new OutboxRelay({
      pool: deps.pool,
      producer: deps.producer,
      schema: deps.schema,
      logger: deps.logger,
      metrics: createRelayMetrics(deps.registry, deps.pool, deps.schema),
    });
    this.jobs = new JobRunner(options.jobs?.(deps) ?? [], (job, error) => {
      deps.logger.warn(
        { job: job.name, err: error instanceof Error ? error.message : String(error) },
        'job failed',
      );
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.deps.producer.connect();
    this.relay.start();
    this.jobs.start();
    for (const runtime of this.runtimes) await runtime.start();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const runtime of this.runtimes) await runtime.stop();
    await this.jobs.stop();
    await this.relay.stop();
    await this.deps.producer.disconnect();
    await this.deps.pool.end();
  }
}

export const SERVICE_LIFECYCLE = Symbol('SERVICE_LIFECYCLE');

@Module({})
class ConsumerServiceModule {
  static forRoot(options: ConsumerServiceOptions): DynamicModule {
    const logOptions = loggerOptions({ service: options.service, level: options.config.logLevel });
    return {
      module: ConsumerServiceModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: options.logDestination ? [logOptions, options.logDestination] : logOptions,
        }),
        ...(options.http?.imports ?? []),
      ],
      controllers: [HealthController, MetricsController, ...(options.http?.controllers ?? [])],
      providers: [
        ...(options.http?.providers ?? []),
        { provide: OPTIONS, useValue: options },
        {
          provide: DEPS,
          useFactory: (): ServiceDeps => {
            const logger = createLogger({
              service: options.service,
              level: options.config.logLevel,
              ...(options.logDestination ? { destination: options.logDestination } : {}),
            });
            const kafka = createKafka({
              brokers: options.config.kafkaBrokers,
              clientId: options.service,
            });
            return {
              service: options.service,
              schema: options.schema,
              pool: createPool({
                connectionString: options.config.databaseUrl,
                applicationName: options.service,
                onIdleError: (err) => {
                  logger.warn({ err: err.message }, 'idle database connection lost');
                },
              }),
              kafka,
              // Bounded delivery so a broker outage fails a batch instead of hanging it.
              producer: createProducer(kafka, { 'message.timeout.ms': 15_000 }),
              outbox: new OutboxWriter(options.schema),
              registry: createMetricsRegistry(options.service),
              logger,
            };
          },
        },
        { provide: METRICS_REGISTRY, inject: [DEPS], useFactory: (d: ServiceDeps) => d.registry },
        {
          provide: SERVICE_LIFECYCLE,
          inject: [DEPS, OPTIONS],
          useFactory: (deps: ServiceDeps, opts: ConsumerServiceOptions) =>
            new ServiceLifecycle(deps, opts),
        },
        {
          provide: READINESS_CHECKS,
          inject: [DEPS, OPTIONS],
          useFactory: (deps: ServiceDeps, opts: ConsumerServiceOptions): ReadinessCheck[] => [
            { name: 'database', check: () => databaseIsReachable(deps.pool) },
            { name: 'kafka', check: () => kafkaIsReachable(deps.kafka, opts.readinessTopic) },
          ],
        },
      ],
    };
  }
}

/** A consumer service with `/health/live`, `/health/ready` and `/metrics`. */
export async function createConsumerService(
  options: ConsumerServiceOptions,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    ConsumerServiceModule.forRoot(options),
    {
      bufferLogs: true,
    },
  );
  const logger = app.get(NestPinoLogger);
  app.useLogger(logger);
  app.disable('x-powered-by');
  app.use(httpMetrics(app.get<ServiceDeps>(DEPS).registry));
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
  return app;
}

/** The consumer runtimes of a running service (tests use them to inspect offsets). */
export function runtimesOf(app: NestExpressApplication): ConsumerRuntime[] {
  return app.get<ServiceLifecycle>(SERVICE_LIFECYCLE).runtimes;
}

export type { Job };
