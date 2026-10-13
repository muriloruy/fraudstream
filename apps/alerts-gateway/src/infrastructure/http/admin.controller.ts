import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { allTopics, dlqTopic, TOPIC_CATALOGUE } from '@fraudstream/contracts';
import { ProblemException, ZodValidationPipe } from '@fraudstream/http';
import { replayDlq } from '@fraudstream/kafka';
import { hmacSha256Hex } from '@fraudstream/security';
import { z } from 'zod';
import type { Principal } from '../../auth/tokens.js';
import type { Gateway } from '../../gateway.js';
import { Authorized, CurrentPrincipal, type GatewayRequest } from './auth.guard.js';
import { GATEWAY } from './tokens.js';

/** Only DLQ topics of the catalogue can be replayed (allow-list, not a pattern). */
const DLQ_TOPICS = new Set(
  TOPIC_CATALOGUE.flatMap((t) => t.consumerGroups.map((g) => dlqTopic(t.name, g))),
);
const OFFSET = /^\d{1,19}$/;
const Offset = z.string().regex(OFFSET, 'must be a non-negative integer');

export const ReplayBody = z
  .strictObject({
    topic: z.string().refine((t) => DLQ_TOPICS.has(t), 'must be a DLQ topic of the catalogue'),
    from: Offset,
    to: Offset,
    partition: z.number().int().min(0).max(1000).optional(),
    dryRun: z.boolean().default(false),
  })
  // Zod runs this refinement even when a field failed: guard before BigInt() (it throws).
  .refine((b) => !OFFSET.test(b.from) || !OFFSET.test(b.to) || BigInt(b.from) <= BigInt(b.to), {
    message: 'from must be <= to',
    path: ['to'],
  });
type ReplayBody = z.infer<typeof ReplayBody>;

export interface LagRow {
  group: string;
  topic: string;
  partition: number;
  committed: string | null;
  end: string;
  lag: string;
}

@Controller('admin')
@Authorized('admin')
export class AdminController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  /** Republishes a DLQ offset range to its original topic (or a dry run), audited. */
  @Post('dlq/replay')
  @HttpCode(200)
  async replay(
    @Body(new ZodValidationPipe(ReplayBody)) body: ReplayBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: GatewayRequest,
  ) {
    const { kafka, producer, pool } = this.gateway.deps;
    const results = await replayDlq({
      kafka,
      producer,
      dlqTopic: body.topic,
      from: BigInt(body.from),
      to: BigInt(body.to),
      ...(body.partition === undefined ? {} : { partition: body.partition }),
      dryRun: body.dryRun,
    });
    await this.gateway.audit.record(pool, {
      actorId: principal.userId,
      action: 'DLQ_REPLAYED',
      targetType: 'topic',
      targetId: body.topic,
      metadata: {
        from: body.from,
        to: body.to,
        partition: body.partition ?? null,
        dryRun: body.dryRun,
        messages: results.length,
        replayed: results.filter((r) => r.replayed).length,
      },
      ipHash: hmacSha256Hex(this.gateway.config.hashPepper, req.ip ?? 'unknown'),
    });
    return { dryRun: body.dryRun, results };
  }

  /** Lag per consumer group, topic and partition (source and retry topics) via the admin API. */
  @Get('consumers/lag')
  async lag(): Promise<{ items: LagRow[] }> {
    const admin = this.gateway.deps.kafka.admin();
    await admin.connect();
    try {
      const known = new Set(allTopics().map((t) => t.name));
      const items: LagRow[] = [];
      for (const source of TOPIC_CATALOGUE) {
        for (const group of source.consumerGroups) {
          const topics = [source.name, `${source.name}.${group}.retry`].filter((t) => known.has(t));
          const committed = await admin.fetchOffsets({ groupId: group, topics });
          for (const topic of topics) {
            const ends = await admin.fetchTopicOffsets(topic);
            const byPartition = new Map(
              (committed.find((c) => c.topic === topic)?.partitions ?? []).map((p) => [
                p.partition,
                p.offset,
              ]),
            );
            for (const end of ends) {
              const c = byPartition.get(end.partition);
              const start = c !== undefined && BigInt(c) >= 0n ? BigInt(c) : BigInt(end.low);
              const lag = BigInt(end.high) - start;
              items.push({
                group,
                topic,
                partition: end.partition,
                committed: c !== undefined && BigInt(c) >= 0n ? c : null,
                end: end.high,
                lag: (lag < 0n ? 0n : lag).toString(),
              });
            }
          }
        }
      }
      return { items };
    } catch (error) {
      throw ProblemException.of(
        503,
        'Service Unavailable',
        error instanceof Error ? 'Kafka admin API unavailable' : undefined,
      );
    } finally {
      await admin.disconnect();
    }
  }
}
