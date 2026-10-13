import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { hash } from '@node-rs/argon2';
import { startKafka, startPostgres, type TestKafka, type TestPostgres } from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway, type GatewayStack } from './harness.js';

/**
 * alerts-gateway security tests (SPEC §13.5): brute-force lockout, refresh token reuse and
 * SQL injection payloads on every string input, against the real service process.
 */
const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE alerts.alerts;--",
  '" OR 1=1 --',
  '1; SELECT pg_sleep(5)--',
  "x' UNION SELECT password_hash FROM auth.users--",
];
const PASSWORD = 'a long and correct passphrase';

let db: TestPostgres;
let kafka: TestKafka;
let gw: GatewayStack;
let host = 20;

interface Reply {
  status: number;
  body: string;
  setCookie: string[];
}

/** HTTP from a distinct loopback address per call site, so login throttling is per test. */
function http(
  method: string,
  path: string,
  o: { body?: unknown; bearer?: string; cookie?: string; from?: string } = {},
): Promise<Reply> {
  const url = new URL(path, gw.url);
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        localAddress: o.from ?? '127.0.0.1',
        headers: {
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookie: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const ip = () => `127.0.0.${String(host++)}`;
const refreshCookie = (r: Reply) =>
  r.setCookie.find((c) => c.startsWith('fs_refresh='))?.split(';')[0] ?? '';

async function addUser(email: string, role: 'analyst' | 'admin') {
  await gw.alerts.query(
    `INSERT INTO auth.users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4)`,
    [
      randomUUID(),
      email,
      await hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      role,
    ],
  );
}

/** Schemas, tables and row counts of everything an injection could alter (not the audit log). */
async function snapshot(): Promise<string> {
  const { rows } = await gw.alerts.query<{ s: string }>(
    `SELECT (SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY 1)
               FROM information_schema.tables WHERE table_schema IN ('alerts', 'auth'))
            || '|' || (SELECT count(*) FROM auth.users) || '|' || (SELECT count(*) FROM alerts.alerts)
            || '|' || (SELECT string_agg(password_hash || role || failed_logins, ',' ORDER BY email) FROM auth.users) AS s`,
  );
  return rows[0]?.s ?? '';
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  gw = await startGateway(db, kafka);
  await addUser('analyst@sec.local', 'analyst');
  await addUser('admin@sec.local', 'admin');
});

afterAll(async () => {
  await gw.stop();
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('brute force', () => {
  it('locks an account after 5 failures and throttles a client after 10 attempts per minute', async () => {
    await addUser('target@sec.local', 'analyst');
    const attacker = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await http('POST', '/auth/login', {
            body: { email: 'target@sec.local', password: `guess-${String(i)}` },
            from: attacker,
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5, 10).every((s) => s === 423)).toBe(true); // locked
    expect(statuses[10]).toBe(429); // throttled
    // the real user, from another address, is locked out too until the 15 minutes pass
    const owner = await http('POST', '/auth/login', {
      body: { email: 'target@sec.local', password: PASSWORD },
      from: ip(),
    });
    expect(owner.status).toBe(423);
  });
});

describe('refresh token reuse', () => {
  it('revokes the whole family when a rotated token is replayed', async () => {
    const login = await http('POST', '/auth/login', {
      body: { email: 'analyst@sec.local', password: PASSWORD },
      from: ip(),
    });
    const stolen = refreshCookie(login);
    const rotated = await http('POST', '/auth/refresh', { cookie: stolen });
    expect(rotated.status).toBe(200);
    expect((await http('POST', '/auth/refresh', { cookie: stolen })).status).toBe(401); // attacker replays
    expect((await http('POST', '/auth/refresh', { cookie: refreshCookie(rotated) })).status).toBe(
      401,
    ); // victim's session ends too
  });
});

describe('SQL injection on every string input (SPEC §13.5)', () => {
  it('rejects payloads with 400 (or a generic 401/404 for free text) and leaves the DB untouched', async () => {
    const before = await snapshot();
    const login = await http('POST', '/auth/login', {
      body: { email: 'admin@sec.local', password: PASSWORD },
      from: ip(),
    });
    const token = (JSON.parse(login.body) as { accessToken: string }).accessToken;
    const alertId = randomUUID();
    const results: string[] = [];
    const expectStatus = async (label: string, reply: Promise<Reply>, allowed: number[]) => {
      const r = await reply;
      if (!allowed.includes(r.status)) results.push(`${label}: ${String(r.status)}`);
      for (const p of PAYLOADS) if (r.body.includes(p)) results.push(`${label}: payload echoed`);
    };
    for (const p of PAYLOADS) {
      const q = encodeURIComponent(p);
      await expectStatus(
        'login email',
        http('POST', '/auth/login', { body: { email: p, password: 'x' }, from: ip() }),
        [400],
      );
      // passwords are free text: a payload is just a wrong password
      await expectStatus(
        'login password',
        http('POST', '/auth/login', {
          body: { email: 'nobody@sec.local', password: p },
          from: ip(),
        }),
        [401],
      );
      for (const param of ['status', 'minScore', 'accountId', 'cursor', 'limit']) {
        await expectStatus(
          `alerts ?${param}`,
          http('GET', `/v1/alerts?${param}=${q}`, { bearer: token }),
          [400],
        );
      }
      await expectStatus('alert id', http('GET', `/v1/alerts/${q}`, { bearer: token }), [400]);
      await expectStatus(
        'assign id',
        http('POST', `/v1/alerts/${q}/assign`, { bearer: token }),
        [400],
      );
      await expectStatus(
        'resolve verdict',
        http('POST', `/v1/alerts/${alertId}/resolve`, {
          bearer: token,
          body: { verdict: p, note: 'n' },
        }),
        [400],
      );
      // notes are free text: stored as a parameter, here for an unknown alert
      await expectStatus(
        'resolve note',
        http('POST', `/v1/alerts/${alertId}/resolve`, {
          bearer: token,
          body: { verdict: 'LEGITIMATE', note: p },
        }),
        [404],
      );
      await expectStatus(
        'timeline account',
        http('GET', `/v1/accounts/${q}/timeline`, { bearer: token }),
        [400],
      );
      await expectStatus(
        'summary window',
        http('GET', `/v1/metrics/summary?window=${q}`, { bearer: token }),
        [400],
      );
      for (const field of ['topic', 'from', 'to']) {
        await expectStatus(
          `replay ${field}`,
          http('POST', '/admin/dlq/replay', {
            bearer: token,
            body: {
              topic: 'fraud.decisions.v1.alerts-gateway.dlq',
              from: '0',
              to: '1',
              [field]: p,
            },
          }),
          [400],
        );
      }
      await expectStatus(
        'refresh cookie',
        http('POST', '/auth/refresh', { cookie: `fs_refresh=${q}` }),
        [401],
      );
    }
    expect(results).toEqual([]);
    expect(await snapshot()).toBe(before);
  });
});
