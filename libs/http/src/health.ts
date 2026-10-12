import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { ProblemException } from './problem.js';

/** A named readiness dependency, e.g. `database` or `kafka`. */
export interface ReadinessCheck {
  name: string;
  check(): Promise<boolean>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

/** `/health/live` (process up) and `/health/ready` (all dependencies reachable). */
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const results = await Promise.all(
      this.checks.map(async (c) => [c.name, await c.check().catch(() => false)] as const),
    );
    const checks = Object.fromEntries(results.map(([name, ok]) => [name, ok ? 'up' : 'down']));
    if (results.some(([, ok]) => !ok)) {
      throw ProblemException.of(
        503,
        'Service Unavailable',
        `dependencies down: ${JSON.stringify(checks)}`,
      );
    }
    return { status: 'ok', checks };
  }
}
