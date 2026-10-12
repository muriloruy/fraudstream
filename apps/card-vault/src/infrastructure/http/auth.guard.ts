import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ProblemException } from '@fraudstream/http';
import { safeEqual } from '@fraudstream/security';
import type { VaultRole } from '../../application/vault.service.js';
import { VAULT_CONFIG } from './tokens.js';
import type { VaultConfig } from '../../config/config.js';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  vaultRole?: VaultRole;
}

/**
 * Callers authenticate with a bearer token: the shared service token (v1 stand-in for
 * mTLS, SPEC §6.2) maps to role `service`, the admin token to `vault-admin`.
 */
@Injectable()
export class VaultAuthGuard implements CanActivate {
  constructor(@Inject(VAULT_CONFIG) private readonly config: VaultConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
    if (token && safeEqual(token, this.config.adminToken)) {
      request.vaultRole = 'vault-admin';
      return true;
    }
    if (token && safeEqual(token, this.config.serviceToken)) {
      request.vaultRole = 'service';
      return true;
    }
    throw ProblemException.of(401, 'Unauthorized');
  }
}
