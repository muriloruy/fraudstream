import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { AccountId } from '@fraudstream/contracts';
import { ProblemException, ZodValidationPipe } from '@fraudstream/http';
import { hmacSha256Hex } from '@fraudstream/security';
import { z } from 'zod';
import { AlertAlreadyResolvedError, AlertNotFoundError } from '../../application/alerts.service.js';
import type { Principal } from '../../auth/tokens.js';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../../domain/cursor.js';
import { parseWindowSeconds } from '../../domain/stats.js';
import type { Gateway } from '../../gateway.js';
import { ALERT_STATUSES, OPEN_STATUSES, type Alert } from '../db/alerts.repository.js';
import { Authorized, CurrentPrincipal, type GatewayRequest } from './auth.guard.js';
import { GATEWAY } from './tokens.js';

// Every string input is allow-listed by shape, so injection payloads are 400s (SPEC §13.5).
const AlertId = z.uuid();
const Score = z
  .string()
  // Bounded quantifiers only, no nested repetition: not vulnerable to ReDoS.
  // eslint-disable-next-line security/detect-unsafe-regex
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'must be a decimal between 0 and 1');

export const ListQuery = z.strictObject({
  status: z
    .string()
    .max(64)
    .transform((v) => v.split(','))
    .pipe(z.array(z.enum(ALERT_STATUSES)).min(1))
    .optional(),
  minScore: Score.optional(),
  accountId: AccountId.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
type ListQuery = z.infer<typeof ListQuery>;

export const ResolveBody = z.strictObject({
  verdict: z.enum(['CONFIRMED_FRAUD', 'LEGITIMATE']),
  note: z.string().trim().min(1, 'a note is required').max(2000),
});
type ResolveBody = z.infer<typeof ResolveBody>;

export const SummaryQuery = z.strictObject({ window: z.string().max(8).default('15m') });

interface SnapshotShape {
  transaction?: { amount?: unknown; merchant?: { name?: unknown; country?: unknown } };
  decision?: { breakdown?: { firedRules?: { ruleId: string; name: string }[] } | null };
}

/** Queue row: the alert without its snapshot, plus the columns the table shows (SPEC §8.2). */
const listItem = ({ snapshot, ...rest }: Alert) => {
  const s = snapshot as SnapshotShape;
  return {
    ...rest,
    amount: s.transaction?.amount ?? null,
    merchantName:
      typeof s.transaction?.merchant?.name === 'string' ? s.transaction.merchant.name : null,
    country:
      typeof s.transaction?.merchant?.country === 'string' ? s.transaction.merchant.country : null,
    firedRules: (s.decision?.breakdown?.firedRules ?? []).map((r) => r.ruleId),
  };
};

@Controller()
@Authorized('analyst')
export class AlertsController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  /** Keyset pagination on (final_score DESC, created_at, alert_id) with a signed cursor. */
  @Get('v1/alerts')
  async list(@Query(new ZodValidationPipe(ListQuery)) q: ListQuery) {
    let after;
    try {
      after = q.cursor ? decodeCursor(q.cursor, this.gateway.config.cursorKey) : undefined;
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw ProblemException.of(400, 'Request validation failed', undefined, [
          { field: 'cursor', message: 'invalid cursor' },
        ]);
      }
      throw error;
    }
    const items = await this.gateway.alerts.list({
      statuses: q.status ?? OPEN_STATUSES,
      ...(q.minScore === undefined ? {} : { minScore: q.minScore }),
      ...(q.accountId === undefined ? {} : { accountId: q.accountId }),
      ...(after ? { after } : {}),
      limit: q.limit,
    });
    const last = items.at(-1);
    return {
      items: items.map(listItem),
      nextCursor:
        last && items.length === q.limit
          ? encodeCursor(
              { finalScore: last.finalScore, createdAt: last.createdAt, alertId: last.alertId },
              this.gateway.config.cursorKey,
            )
          : null,
    };
  }

  /** Details with snapshot; writes ALERT_VIEWED to the audit log. */
  @Get('v1/alerts/:id')
  async detail(
    @Param('id', new ZodValidationPipe(AlertId)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: GatewayRequest,
  ) {
    return this.mapErrors(() => this.gateway.alerts.view(id, principal, this.ipHash(req)));
  }

  @Post('v1/alerts/:id/assign')
  @HttpCode(200)
  async assign(
    @Param('id', new ZodValidationPipe(AlertId)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: GatewayRequest,
  ) {
    return this.mapErrors(() => this.gateway.alerts.assign(id, principal, this.ipHash(req)));
  }

  /** Verdict + required note; 409 when the alert is already resolved. */
  @Post('v1/alerts/:id/resolve')
  @HttpCode(200)
  async resolve(
    @Param('id', new ZodValidationPipe(AlertId)) id: string,
    @Body(new ZodValidationPipe(ResolveBody)) body: ResolveBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: GatewayRequest,
  ) {
    return this.mapErrors(() =>
      this.gateway.alerts.resolve(id, principal, body.verdict, body.note, this.ipHash(req)),
    );
  }

  /** Profile, balance and recent activity of an account (SPEC §8.2 Account Timeline). */
  @Get('v1/accounts/:accountId')
  async account(@Param('accountId', new ZodValidationPipe(AccountId)) accountId: string) {
    const view = await this.gateway.alerts.account(accountId);
    return { accountId, ...view };
  }

  /** Last 100 decisions and ledger postings of the account, newest first. */
  @Get('v1/accounts/:accountId/timeline')
  async timeline(@Param('accountId', new ZodValidationPipe(AccountId)) accountId: string) {
    return { accountId, items: await this.gateway.alerts.timeline(accountId) };
  }

  @Get('v1/metrics/summary')
  async summary(@Query(new ZodValidationPipe(SummaryQuery)) q: z.infer<typeof SummaryQuery>) {
    const seconds = parseWindowSeconds(q.window);
    if (seconds === null) {
      throw ProblemException.of(400, 'Request validation failed', undefined, [
        { field: 'window', message: 'must be like 30s, 15m or 1h (at most 24h)' },
      ]);
    }
    return this.gateway.alerts.summary(seconds);
  }

  private async mapErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AlertNotFoundError) throw ProblemException.of(404, 'Not Found');
      if (error instanceof AlertAlreadyResolvedError) {
        throw ProblemException.of(409, 'Conflict', 'the alert is already resolved');
      }
      throw error;
    }
  }

  private ipHash(req: GatewayRequest): string {
    return hmacSha256Hex(this.gateway.config.hashPepper, req.ip ?? 'unknown');
  }
}
