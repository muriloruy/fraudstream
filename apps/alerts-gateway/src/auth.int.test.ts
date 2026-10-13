import { randomUUID } from 'node:crypto';
import { createPool, migrate, type Pool } from '@fraudstream/db';
import {
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { hashPassword } from './auth/passwords.js';
import { loadConfig } from './config/config.js';
import { UsersRepository } from './infrastructure/db/users.repository.js';
import { call, freshIp, type CallOptions } from './testing/client.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;

const PASSWORD = 'correct horse battery staple';
const users = { analyst: 'analyst@demo.local', admin: 'admin@demo.local' } as const;

const http = (method: string, path: string, o?: CallOptions) => call(base, method, path, o);
const login = (email: string, password = PASSWORD, from = freshIp()) =>
  http('POST', '/auth/login', { body: { email, password }, from });
async function tokenFor(email: string): Promise<string> {
  const res = await login(email);
  expect(res.status).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

async function addUser(email: string, role: 'analyst' | 'admin') {
  await new UsersRepository().upsertUser(pool, {
    userId: randomUUID(),
    email,
    passwordHash: await hashPassword(PASSWORD),
    role,
  });
}

const auditRows = async (action: string) =>
  (
    await pool.query<{ actor_id: string; target_id: string; ip_hash: string | null }>(
      'SELECT actor_id, target_id, ip_hash FROM alerts.audit_log WHERE action = $1 ORDER BY id',
      [action],
    )
  ).rows;

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('alerts_svc');
  for (const schema of ['auth', 'alerts']) {
    await migrate({ databaseUrl: url, schema, dir: repoPath(`migrations/${schema}`) });
  }
  pool = createPool({ connectionString: url, applicationName: 'test' });
  await addUser(users.analyst, 'analyst');
  await addUser(users.admin, 'admin');
  app = await createApp(
    loadConfig({
      DATABASE_URL_ALERTS: url,
      KAFKA_BROKERS: kafka.brokers.join(','),
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
      HASH_PEPPER: 'test-pepper-of-sufficient-length',
    }),
  );
  await app.listen(0, '0.0.0.0'); // all loopback addresses, so tests can use distinct client IPs
  const address = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('login (SPEC §6.8, §7 Req. 8)', () => {
  it('returns an access token and an httpOnly, Secure, SameSite=Strict refresh cookie', async () => {
    const res = await login(users.analyst);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { email: users.analyst, role: 'analyst' },
    });
    const cookie = res.cookies.get('fs_refresh');
    expect(cookie?.value).toMatch(/^[\w-]{43}$/);
    expect(cookie?.attributes).toMatch(/HttpOnly/);
    expect(cookie?.attributes).toMatch(/Secure/);
    expect(cookie?.attributes).toMatch(/SameSite=Strict/);
    expect(cookie?.attributes).toMatch(/Path=\/auth/);
    expect((await auditRows('LOGIN')).length).toBeGreaterThan(0);
  });

  it('stores passwords as argon2id', async () => {
    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM auth.users LIMIT 1',
    );
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('answers a wrong password and an unknown email identically, and audits both', async () => {
    const wrong = await login(users.analyst, 'not the password');
    const unknown = await login('nobody@demo.local', 'whatever-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    const failed = await auditRows('LOGIN_FAILED');
    expect(failed.some((r) => r.target_id === 'unknown')).toBe(true);
    expect(failed.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash ?? ''))).toBe(true);
    // a successful login resets the counter for the next tests
    expect((await login(users.analyst)).status).toBe(200);
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    const email = 'locked@demo.local';
    await addUser(email, 'analyst');
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await login(email, 'wrong-password', ip)).status).toBe(401);
    const locked = await login(email, PASSWORD, freshIp());
    expect(locked.status).toBe(423);
    expect(locked.body).not.toContain(email);
    const { rows } = await pool.query<{ minutes: number }>(
      'SELECT round(extract(epoch FROM locked_until - now()) / 60) AS minutes FROM auth.users WHERE email = $1',
      [email],
    );
    expect(Number(rows[0]?.minutes)).toBe(15);
  });

  it('rate limits login to 10 requests per minute per IP (429)', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await login('nobody@demo.local', 'x', ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await login(users.admin, PASSWORD, freshIp())).status).toBe(200); // other clients unaffected
  });

  it('rejects malformed bodies with 400 and no echo', async () => {
    const res = await http('POST', '/auth/login', {
      body: { email: "' OR 1=1 --", password: 'x', extra: true },
      from: freshIp(),
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain('OR 1=1');
  });
});

describe('refresh rotation, reuse detection and logout', () => {
  it('rotates; reusing an old token revokes the whole family', async () => {
    const first = (await login(users.analyst)).cookies.get('fs_refresh')?.value ?? '';
    const rotated = await http('POST', '/auth/refresh', { cookies: { fs_refresh: first } });
    expect(rotated.status).toBe(200);
    expect(rotated.json()).toHaveProperty('accessToken');
    const second = rotated.cookies.get('fs_refresh')?.value ?? '';
    expect(second).not.toBe(first);

    const reuse = await http('POST', '/auth/refresh', { cookies: { fs_refresh: first } });
    expect(reuse.status).toBe(401);
    const afterReuse = await http('POST', '/auth/refresh', { cookies: { fs_refresh: second } });
    expect(afterReuse.status).toBe(401); // the newest token of the family no longer works
    // both presentations of a revoked token are audited as reuse
    expect((await auditRows('TOKEN_REUSE_DETECTED')).length).toBe(2);
  });

  it('rejects a refresh after logout', async () => {
    const token = (await login(users.analyst)).cookies.get('fs_refresh')?.value ?? '';
    const out = await http('POST', '/auth/logout', { cookies: { fs_refresh: token } });
    expect(out.status).toBe(204);
    expect(out.cookies.get('fs_refresh')?.value).toBe('');
    expect((await http('POST', '/auth/refresh', { cookies: { fs_refresh: token } })).status).toBe(
      401,
    );
  });

  it('rejects a missing or forged refresh cookie', async () => {
    expect((await http('POST', '/auth/refresh')).status).toBe(401);
    expect(
      (await http('POST', '/auth/refresh', { cookies: { fs_refresh: 'forged' } })).status,
    ).toBe(401);
  });
});

describe('access tokens', () => {
  it('rejects tampered, foreign-audience and alg=none tokens', async () => {
    const token = await tokenFor(users.analyst);
    const [h, p, s] = token.split('.');
    const tampered = `${h ?? ''}.${p ?? ''}x.${s ?? ''}`;
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p ?? ''}.`;
    for (const bad of [tampered, none, 'garbage']) {
      expect((await http('GET', '/v1/alerts', { bearer: bad })).status).toBe(401);
    }
    // a stream cookie token is not an API token (different audience)
    const session = await http('POST', '/auth/stream-session', { bearer: token });
    expect(session.status).toBe(204);
    const streamToken = session.cookies.get('fs_stream');
    expect(streamToken?.attributes).toMatch(/Path=\/v1\/stream/);
    expect(streamToken?.attributes).toMatch(/HttpOnly/);
    expect((await http('GET', '/v1/alerts', { bearer: streamToken?.value ?? '' })).status).toBe(
      401,
    );
  });
});

describe('AuthZ matrix: every endpoint × role (SPEC §13.5)', () => {
  const id = randomUUID();
  // expected: 'denied-401' | 'denied-403' | 'allowed' (any status other than 401/403)
  const matrix: [
    string,
    string,
    CallOptions['body'],
    Record<'anonymous' | 'analyst' | 'admin', string>,
  ][] = [
    ['GET', '/v1/alerts', undefined, { anonymous: '401', analyst: 'allowed', admin: 'allowed' }],
    [
      'GET',
      `/v1/alerts/${id}`,
      undefined,
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'POST',
      `/v1/alerts/${id}/assign`,
      undefined,
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'POST',
      `/v1/alerts/${id}/resolve`,
      { verdict: 'LEGITIMATE', note: 'n' },
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'GET',
      '/v1/accounts/acc_1/timeline',
      undefined,
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'GET',
      '/v1/metrics/summary',
      undefined,
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'POST',
      '/auth/stream-session',
      undefined,
      { anonymous: '401', analyst: 'allowed', admin: 'allowed' },
    ],
    ['GET', '/v1/stream', undefined, { anonymous: '401', analyst: '401', admin: '401' }], // cookie only, never a bearer token
    [
      'POST',
      '/admin/dlq/replay',
      { topic: 'x', from: '0', to: '0' },
      { anonymous: '401', analyst: '403', admin: 'allowed' },
    ],
    [
      'GET',
      '/admin/consumers/lag',
      undefined,
      { anonymous: '401', analyst: '403', admin: 'allowed' },
    ],
    [
      'POST',
      '/auth/login',
      { email: 'a@b.c', password: 'x' },
      { anonymous: 'allowed', analyst: 'allowed', admin: 'allowed' },
    ],
    [
      'POST',
      '/auth/logout',
      undefined,
      { anonymous: 'allowed', analyst: 'allowed', admin: 'allowed' },
    ],
  ];

  it('matches the expected status class for every cell', async () => {
    const tokens = {
      anonymous: undefined,
      analyst: await tokenFor(users.analyst),
      admin: await tokenFor(users.admin),
    };
    const actual: string[] = [];
    const expected: string[] = [];
    for (const [method, path, body, roles] of matrix) {
      for (const role of ['anonymous', 'analyst', 'admin'] as const) {
        const bearer = tokens[role];
        const res = await http(method, path, {
          ...(bearer ? { bearer } : {}),
          ...(body === undefined ? {} : { body }),
          from: freshIp(),
        });
        const got = res.status === 401 || res.status === 403 ? String(res.status) : 'allowed';
        actual.push(`${method} ${path} ${role}: ${got}`);
        expected.push(`${method} ${path} ${role}: ${roles[role]}`);
      }
    }
    expect(actual).toEqual(expected);
  });
});

describe('platform', () => {
  it('serves the OpenAPI document and hardening headers', async () => {
    const res = await http('GET', '/docs-json');
    expect(res.status).toBe(200);
    const doc = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/alerts', '/auth/login', '/admin/dlq/replay']),
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS with credentials for listed origins only', async () => {
    const ok = await http('OPTIONS', '/v1/alerts', {
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await http('OPTIONS', '/v1/alerts', {
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
