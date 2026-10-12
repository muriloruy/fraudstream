import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ProblemException, ZodValidationPipe } from '@fraudstream/http';
import { isValidPan } from '@fraudstream/security';
import { z } from 'zod';
import {
  CardNotFoundError,
  DetokenizeForbiddenError,
  type VaultService,
} from '../../application/vault.service.js';
import { wipe } from '../../domain/crypto.js';
import { VaultAuthGuard, type AuthenticatedRequest } from './auth.guard.js';
import { VAULT_SERVICE } from './tokens.js';

const TokenizeRequest = z.strictObject({
  pan: z.string().refine(isValidPan, 'must be 13-19 digits with a valid Luhn check digit'),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(2100),
});

const DetokenizeRequest = z.strictObject({
  cardToken: z.string().regex(/^tok_[0-9A-Za-z]{16,64}$/),
});

@Controller('internal')
@UseGuards(VaultAuthGuard)
export class VaultController {
  constructor(@Inject(VAULT_SERVICE) private readonly vault: VaultService) {}

  @Post('tokenize')
  @HttpCode(200)
  async tokenize(
    @Body(new ZodValidationPipe(TokenizeRequest)) body: z.infer<typeof TokenizeRequest>,
  ) {
    // JSON parsing already produced a string we cannot wipe; keep the copy we control in a
    // Buffer and zero it as soon as tokenization is done (SPEC §6.2 memory hygiene).
    const pan = Buffer.from(body.pan, 'ascii');
    try {
      return await this.vault.tokenize({
        pan,
        expiryMonth: body.expiryMonth,
        expiryYear: body.expiryYear,
      });
    } finally {
      wipe(pan);
    }
  }

  @Post('detokenize')
  @HttpCode(200)
  async detokenize(
    @Body(new ZodValidationPipe(DetokenizeRequest)) body: z.infer<typeof DetokenizeRequest>,
    @Req() request: AuthenticatedRequest,
  ) {
    try {
      return await this.vault.detokenize(body.cardToken, request.vaultRole ?? 'service');
    } catch (error) {
      if (error instanceof DetokenizeForbiddenError) throw ProblemException.of(403, 'Forbidden');
      if (error instanceof CardNotFoundError) throw ProblemException.of(404, 'Not Found');
      throw error;
    }
  }
}
