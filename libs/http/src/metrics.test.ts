import 'reflect-metadata';
import { Controller, Get, Module, Param } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createMetricsRegistry } from '@fraudstream/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpMetrics, METRICS_REGISTRY, MetricsController } from './index.js';

@Controller('v1/things')
class ThingsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

const registry = createMetricsRegistry('test', false);

@Module({
  controllers: [ThingsController, MetricsController],
  providers: [{ provide: METRICS_REGISTRY, useValue: registry }],
})
class TestModule {}

let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
  app.use(httpMetrics(registry));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('http metrics (SPEC §10)', () => {
  it('reports http_request_duration_seconds by route template and status', async () => {
    await fetch(`${base}/v1/things/1`);
    await fetch(`${base}/v1/things/2`);
    await fetch(`${base}/nowhere/42`);

    const res = await fetch(`${base}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain(
      'http_request_duration_seconds_count{service="test",method="GET",route="/v1/things/:id",status="200"} 2',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{service="test",method="GET",route="unmatched",status="404"} 1',
    );
    // Raw ids never become label values.
    expect(text).not.toContain('/v1/things/1"');
  });
});
