/**
 * Sample NestJS consumer: records every TestHappened event in `effects`, exactly once.
 * Shows the intended wiring for services from M3 on (SPEC §6.4-§6.8).
 */
import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from '@fraudstream/db';
import { testEvent } from '../src/__fixtures__/test-event.js';
import type { Kafka, Producer } from '../src/client.js';
import { on } from '../src/consumer/runtime.js';
import { KafkaConsumerModule } from '../src/nest.js';

export interface ExampleDeps {
  kafka: Kafka;
  pool: Pool;
  producer: Producer;
  topic: string;
  group: string;
}

@Module({})
export class ExampleConsumerAppModule {
  static forRoot(deps: ExampleDeps): DynamicModule {
    return {
      module: ExampleConsumerAppModule,
      imports: [
        KafkaConsumerModule.forFeature({
          name: 'effects',
          useFactory: () => ({
            kafka: deps.kafka,
            pool: deps.pool,
            producer: deps.producer,
            group: deps.group,
            schema: 'payments',
            handlers: [
              on(testEvent(deps.topic), async (event, ctx) => {
                await ctx.tx.query('INSERT INTO effects (event_id, key, n) VALUES ($1, $2, $3)', [
                  event.eventId,
                  event.payload.key,
                  event.payload.n,
                ]);
              }),
            ],
          }),
        }),
      ],
    };
  }
}
