import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConsumerRuntime, type ConsumerRuntimeOptions } from './consumer/runtime.js';

export interface KafkaConsumerModuleOptions {
  /** Unique per consumer in the app; also the token the runtime can be injected with. */
  name: string;
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (...deps: never[]) => ConsumerRuntimeOptions | Promise<ConsumerRuntimeOptions>;
}

/** Injection token of the runtime registered under `name`. */
export const consumerToken = (name: string): string => `KAFKA_CONSUMER:${name}`;

/** Starts the runtime when the app is ready; stops it gracefully on shutdown (SIGTERM). */
class ConsumerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(readonly runtime: ConsumerRuntime) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.runtime.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }
}

/**
 * NestJS wrapper of the consumer runtime. Enable `app.enableShutdownHooks()` so SIGTERM
 * stops the consumer gracefully: in-flight message finished and committed, then disconnect.
 */
@Module({})
export class KafkaConsumerModule {
  static forFeature(options: KafkaConsumerModuleOptions): DynamicModule {
    const hostToken = `${consumerToken(options.name)}:host`;
    return {
      module: KafkaConsumerModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: hostToken,
          inject: options.inject ?? [],
          useFactory: async (...deps: never[]) =>
            new ConsumerHost(new ConsumerRuntime(await options.useFactory(...deps))),
        },
        {
          provide: consumerToken(options.name),
          inject: [hostToken],
          useFactory: (host: ConsumerHost) => host.runtime,
        },
      ],
      exports: [consumerToken(options.name)],
    };
  }
}
