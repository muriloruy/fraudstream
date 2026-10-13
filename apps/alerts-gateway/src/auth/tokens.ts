import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export type Role = 'analyst' | 'admin';

export interface Principal {
  userId: string;
  email: string;
  role: Role;
}

const ISSUER = 'fraudstream/alerts-gateway';
const ACCESS_AUDIENCE = 'fraudstream/api';
const STREAM_AUDIENCE = 'fraudstream/stream';

/**
 * HS256 JWTs. Access tokens (15 min) travel in the Authorization header and live in the
 * dashboard's memory only; stream tokens are a separate audience so an SSE cookie can never be
 * replayed as an API bearer token, and vice versa (ADR-006).
 */
export class TokenService {
  constructor(
    private readonly secret: Uint8Array,
    private readonly accessTtlMs: number,
    private readonly streamTtlMs: number,
  ) {}

  signAccess(p: Principal): Promise<string> {
    return this.sign(p, ACCESS_AUDIENCE, this.accessTtlMs);
  }

  signStream(p: Principal): Promise<string> {
    return this.sign(p, STREAM_AUDIENCE, this.streamTtlMs);
  }

  verifyAccess(token: string): Promise<Principal | null> {
    return this.verify(token, ACCESS_AUDIENCE);
  }

  verifyStream(token: string): Promise<Principal | null> {
    return this.verify(token, STREAM_AUDIENCE);
  }

  get accessTtlSeconds(): number {
    return Math.floor(this.accessTtlMs / 1000);
  }

  private sign(p: Principal, audience: string, ttlMs: number): Promise<string> {
    return new SignJWT({ email: p.email, role: p.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(p.userId)
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor((Date.now() + ttlMs) / 1000))
      .sign(this.secret);
  }

  private async verify(token: string, audience: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience,
        algorithms: ['HS256'], // never "none", never an algorithm chosen by the token
      });
      const { sub, email, role } = payload;
      if (typeof sub !== 'string' || typeof email !== 'string') return null;
      if (role !== 'analyst' && role !== 'admin') return null;
      return { userId: sub, email, role };
    } catch {
      return null;
    }
  }
}

/** Opaque refresh token: 32 random bytes; only its SHA-256 is stored. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
