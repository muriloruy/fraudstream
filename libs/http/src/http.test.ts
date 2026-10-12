import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HealthController,
  ProblemDetailsFilter,
  ProblemException,
  READINESS_CHECKS,
  ZodValidationPipe,
} from './index.js';

const Schema = z.strictObject({ card: z.strictObject({ pan: z.string().regex(/^\d{16}$/) }) });
let dbUp = true;

@Controller()
class TestController {
  @Post('validate')
  validate(@Body(new ZodValidationPipe(Schema)) body: z.infer<typeof Schema>) {
    return { ok: body.card.pan.length };
  }

  @Get('conflict')
  conflict() {
    throw ProblemException.of(409, 'Conflict', 'request in progress');
  }

  @Get('crash')
  crash() {
    throw new Error('secret internal detail');
  }
}

@Module({
  controllers: [TestController, HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      useValue: [{ name: 'database', check: () => Promise.resolve(dbUp) }],
    },
  ],
})
class TestModule {}

let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
  app.useBodyParser('json', { limit: '1kb' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

const post = (path: string, body: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('ZodValidationPipe + ProblemDetailsFilter', () => {
  it('returns RFC 9457 errors with field paths but never the submitted value', async () => {
    const res = await post('/validate', JSON.stringify({ card: { pan: '4111-secret-value' } }));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const text = await res.text();
    expect(text).not.toContain('4111-secret-value');
    expect(JSON.parse(text)).toMatchObject({
      type: 'about:blank',
      title: 'Request validation failed',
      status: 400,
      errors: [{ field: 'card.pan' }],
    });
  });

  it('rejects unknown fields', async () => {
    const res = await post(
      '/validate',
      JSON.stringify({ card: { pan: '4111111111111111' }, x: 1 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ field: 'x', message: 'unknown field' }] });
  });

  it('accepts a valid body', async () => {
    const res = await post('/validate', JSON.stringify({ card: { pan: '4111111111111111' } }));
    expect(res.status).toBe(201);
  });

  it('maps malformed JSON and oversized bodies', async () => {
    expect((await post('/validate', '{"card":')).status).toBe(400);
    const big = await post('/validate', JSON.stringify({ card: { pan: 'x'.repeat(2048) } }));
    expect(big.status).toBe(413);
    expect(big.headers.get('content-type')).toContain('application/problem+json');
  });

  it('passes ProblemException through and hides internal errors', async () => {
    expect(await (await fetch(`${base}/conflict`)).json()).toMatchObject({
      status: 409,
      detail: 'request in progress',
    });
    const crash = await fetch(`${base}/crash`);
    expect(crash.status).toBe(500);
    const text = await crash.text();
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toContain('at ');
  });

  it('answers 404 as problem details', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});

describe('HealthController', () => {
  it('reports liveness and readiness', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
    dbUp = false;
    expect((await fetch(`${base}/health/ready`)).status).toBe(503);
    dbUp = true;
  });
});
