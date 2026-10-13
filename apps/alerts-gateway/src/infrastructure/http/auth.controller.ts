import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ProblemException, ZodValidationPipe } from '@fraudstream/http';
import { hmacSha256Hex } from '@fraudstream/security';
import { z } from 'zod';
import {
  AccountLockedError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  type Session,
} from '../../auth/auth.service.js';
import type { Principal } from '../../auth/tokens.js';
import type { Gateway } from '../../gateway.js';
import { Authorized, CurrentPrincipal, readCookie, type GatewayRequest } from './auth.guard.js';
import { GATEWAY } from './tokens.js';

export const REFRESH_COOKIE = 'fs_refresh';
export const STREAM_COOKIE = 'fs_stream';

export const LoginBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
type LoginBody = z.infer<typeof LoginBody>;

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
}

// httpOnly + Secure + SameSite=Strict (SPEC §6.8); each cookie is scoped to the only path that
// reads it, so the refresh token is never sent to the API or the stream.
const cookieOptions = (path: string, maxAgeMs?: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path,
  ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  /** Public. 10 attempts per minute per client IP; 5 failures lock the account for 15 min. */
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: {} })
  async login(
    @Body(new ZodValidationPipe(LoginBody)) body: LoginBody,
    @Req() req: GatewayRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    try {
      const session = await this.gateway.auth.login(body.email, body.password, this.ipHash(req));
      return this.respond(session, res);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        throw ProblemException.of(401, 'Unauthorized', 'invalid email or password');
      }
      if (error instanceof AccountLockedError) {
        throw ProblemException.of(423, 'Locked', 'too many failed attempts; try again later');
      }
      throw error;
    }
  }

  /** Cookie-authenticated. Rotates the refresh token; a reused token revokes its family. */
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: GatewayRequest, @Res({ passthrough: true }) res: CookieResponse) {
    const token = readCookie(req, REFRESH_COOKIE);
    try {
      if (!token) throw new InvalidRefreshTokenError();
      return this.respond(await this.gateway.auth.refresh(token, this.ipHash(req)), res);
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        res.clearCookie(REFRESH_COOKIE, cookieOptions('/auth'));
        throw ProblemException.of(401, 'Unauthorized', 'invalid refresh token');
      }
      throw error;
    }
  }

  /** Any caller: revokes the presented refresh token (if any) and clears the cookies. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: GatewayRequest, @Res({ passthrough: true }) res: CookieResponse) {
    await this.gateway.auth.logout(readCookie(req, REFRESH_COOKIE));
    res.clearCookie(REFRESH_COOKIE, cookieOptions('/auth'));
    res.clearCookie(STREAM_COOKIE, cookieOptions('/v1/stream'));
  }

  /**
   * Exchanges the access token for a short-lived httpOnly cookie valid for `/v1/stream` only:
   * EventSource cannot send headers, and a token in the query string would end up in logs
   * (ADR-006).
   */
  @Post('stream-session')
  @HttpCode(204)
  @Authorized()
  async streamSession(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const token = await this.gateway.tokens.signStream(principal);
    res.cookie(
      STREAM_COOKIE,
      token,
      cookieOptions('/v1/stream', this.gateway.config.streamSessionTtlMs),
    );
  }

  private respond(session: Session, res: CookieResponse) {
    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      cookieOptions('/auth', this.gateway.config.refreshTtlMs),
    );
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: this.gateway.tokens.accessTtlSeconds,
      user: session.principal,
    };
  }

  private ipHash(req: GatewayRequest): string {
    return hmacSha256Hex(this.gateway.config.hashPepper, req.ip ?? 'unknown');
  }
}
