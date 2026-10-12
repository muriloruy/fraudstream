import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ProblemException } from '@fraudstream/http';
import type { ApiKeysRepository } from '../db/api-keys.repository.js';
import { API_KEYS_REPOSITORY } from './tokens.js';

export interface ApiRequest {
  headers: Record<string, string | string[] | undefined>;
  apiKeyId?: string;
}

/** `X-Api-Key` authentication (SPEC §6.1). Sets `apiKeyId`, which rate limiting keys on. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(API_KEYS_REPOSITORY) private readonly apiKeys: ApiKeysRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const key = request.headers['x-api-key'];
    const keyId =
      typeof key === 'string' && key.length > 0 ? await this.apiKeys.authenticate(key) : null;
    if (!keyId) throw ProblemException.of(401, 'Unauthorized', 'missing or invalid X-Api-Key');
    request.apiKeyId = keyId;
    return true;
  }
}
