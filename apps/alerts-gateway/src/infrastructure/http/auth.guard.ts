import {
  applyDecorators,
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProblemException } from '@fraudstream/http';
import type { Principal, Role, TokenService } from '../../auth/tokens.js';
import { TOKENS } from './tokens.js';

export interface GatewayRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  ip?: string;
  principal?: Principal;
}

const REQUIRED_ROLE = 'fraudstream:required-role';
const RANK = new Map<Role, number>([
  ['analyst', 1],
  ['admin', 2],
]);

/**
 * Bearer access token → 401 when missing, malformed or expired; role below the route's → 403
 * (SPEC §6.8: analyst routes accept analyst and admin, admin routes admin only).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(TOKENS) private readonly tokens: TokenService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const principal = token ? await this.tokens.verifyAccess(token) : null;
    if (!principal)
      throw ProblemException.of(401, 'Unauthorized', 'missing or invalid access token');
    const required =
      this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'analyst';
    if ((RANK.get(principal.role) ?? 0) < (RANK.get(required) ?? Infinity))
      throw ProblemException.of(403, 'Forbidden');
    request.principal = principal;
    return true;
  }
}

/** `@Authorized('admin')` on a controller or route. */
export const Authorized = (role: Role = 'analyst') =>
  applyDecorators(SetMetadata(REQUIRED_ROLE, role), UseGuards(AccessGuard));

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<GatewayRequest>().principal;
  if (!principal) throw ProblemException.of(401, 'Unauthorized');
  return principal;
});

/** A cookie set by this service (cookie-parser); names are constants, never request input. */
export function readCookie(req: GatewayRequest, name: string): string | undefined {
  const cookies = req.cookies ?? {};
  return Object.hasOwn(cookies, name)
    ? (Object.getOwnPropertyDescriptor(cookies, name)?.value as string | undefined)
    : undefined;
}
