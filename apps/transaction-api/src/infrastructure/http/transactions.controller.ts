import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ProblemException, ZodValidationPipe } from '@fraudstream/http';
import { z } from 'zod';
import {
  IdempotencyConflictError,
  IdempotencyMismatchError,
  type TransactionsService,
} from '../../application/transactions.service.js';
import { AuthorizationRequest } from '../../domain/authorization-request.js';
import type { TransactionsRepository } from '../db/transactions.repository.js';
import { CardRejectedError, VaultUnavailableError } from '../vault/vault.client.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { TRANSACTIONS_REPOSITORY, TRANSACTIONS_SERVICE } from './tokens.js';

const IdempotencyKey = z.uuid();
const TransactionId = z.uuid();

interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): void;
}

@Controller('v1/transactions')
@UseGuards(ApiKeyGuard)
export class TransactionsController {
  private readonly logger = new Logger(TransactionsController.name);

  constructor(
    @Inject(TRANSACTIONS_SERVICE) private readonly service: TransactionsService,
    @Inject(TRANSACTIONS_REPOSITORY) private readonly transactions: TransactionsRepository,
  ) {}

  /** SPEC §6.1. Rate limited per API key; requires an `Idempotency-Key` UUID header. */
  @Post()
  @UseGuards(ThrottlerGuard)
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(AuthorizationRequest)) body: AuthorizationRequest,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<unknown> {
    if (!IdempotencyKey.safeParse(idempotencyKey).success || idempotencyKey === undefined) {
      throw ProblemException.of(400, 'Request validation failed', undefined, [
        { field: 'Idempotency-Key', message: 'header must be a UUID' },
      ]);
    }
    try {
      const response = await this.service.accept(body, idempotencyKey);
      res.status(response.status);
      const self = (response.body as { links?: { self?: string } }).links?.self;
      if (self) res.setHeader('Location', self);
      return response.body;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw ProblemException.of(
          409,
          'Conflict',
          'a request with this Idempotency-Key is in progress',
        );
      }
      if (error instanceof IdempotencyMismatchError) {
        throw ProblemException.of(
          422,
          'Unprocessable Content',
          'Idempotency-Key reused with a different request body',
        );
      }
      if (error instanceof CardRejectedError) {
        throw ProblemException.of(400, 'Request validation failed', undefined, [
          { field: 'card', message: 'card rejected' },
        ]);
      }
      if (error instanceof VaultUnavailableError) {
        throw ProblemException.of(503, 'Service Unavailable', 'card vault unavailable');
      }
      // Database or other infrastructure failure: nothing was persisted (single DB transaction).
      // Log what failed, never the request: it carries card data.
      const err = error instanceof Error ? error : new Error('unknown error');
      this.logger.error(
        { err: { name: err.name, message: err.message, code: (err as { code?: string }).code } },
        'authorization failed',
      );
      throw ProblemException.of(503, 'Service Unavailable');
    }
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    if (!TransactionId.safeParse(id).success) {
      throw ProblemException.of(400, 'Request validation failed', undefined, [
        { field: 'id', message: 'must be a UUID' },
      ]);
    }
    const transaction = await this.transactions.findById(id);
    if (!transaction) throw ProblemException.of(404, 'Not Found');
    return transaction;
  }
}
