import { randomUUID } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  AccountProfileUpserted,
  AnalystFeedbackRecorded,
  createEnvelope,
  DlqHeaders,
  dlqTopic,
  FraudDecisionMade,
  LedgerEntriesPosted,
  Topics,
  TransactionAuthorizationRequested,
  uuidv7,
  type Envelope,
  type FraudDecisionMadeV1,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { createPool, migrate, type Pool } from '@fraudstream/db';
import { createProducer, eventHeaders, type Producer } from '@fraudstream/kafka';
import {
  readAll,
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
let producer: Producer;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let analyst: string;
let admin: string;
let analystId: string;

const PASSWORD = 'correct horse battery staple';
const http = (method: string, path: string, o?: CallOptions) => call(base, method, path, o);

const fixture = <P>(name: string) =>
  JSON.parse(readFileSync(repoPath(`libs/contracts/fixtures/${name}.json`), 'utf8')) as Envelope<P>;
const txFixture = fixture<TransactionAuthorizationRequestedV1>(
  'transaction-authorization-requested',
);
const decisionFixture = fixture<FraudDecisionMadeV1>('fraud-decision-made');

function transaction(accountId: string) {
  const transactionId = uuidv7();
  return createEnvelope({
    eventType: TransactionAuthorizationRequested.eventType,
    eventVersion: 1,
    producer: 'transaction-api',
    correlationId: transactionId,
    payload: {
      ...txFixture.payload,
      transactionId,
      accountId,
      requestedAt: new Date().toISOString(),
    },
  });
}

function decision(
  tx: Envelope<TransactionAuthorizationRequestedV1>,
  outcome: FraudDecisionMadeV1['decision'],
  finalScore = 0.69,
) {
  return createEnvelope({
    eventType: FraudDecisionMade.eventType,
    eventVersion: 1,
    producer: 'decision-engine',
    correlationId: tx.payload.transactionId,
    payload: {
      ...decisionFixture.payload,
      transactionId: tx.payload.transactionId,
      accountId: tx.payload.accountId,
      decision: outcome,
      finalScore,
      latencyMs: 120,
      decidedAt: new Date().toISOString(),
    },
  });
}

async function publish(
  topic: string,
  events: Envelope<{ accountId: string }>[],
  headers: Record<string, string> = {},
) {
  await producer.send({
    topic,
    messages: events.map((e) => ({
      key: e.payload.accountId,
      value: JSON.stringify(e),
      headers: { ...eventHeaders(e), ...headers },
    })),
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const alertFor = (transactionId: string) =>
  waitFor(async () => {
    const { rows } = await pool.query<{
      alert_id: string;
      status: string;
      snapshot: Record<string, unknown>;
    }>('SELECT alert_id, status, snapshot FROM alerts.alerts WHERE transaction_id = $1', [
      transactionId,
    ]);
    return rows[0];
  });
const processed = (eventId: string) =>
  waitFor(async () => {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM alerts.processed_events WHERE event_id = $1',
      [eventId],
    );
    return rowCount ? true : undefined;
  });

/** Creates an OPEN alert end to end (transaction + REVIEW decision through Kafka). */
async function reviewAlert(accountId: string, score = 0.69) {
  const tx = transaction(accountId);
  await publish(Topics.transactions, [tx]);
  await publish(Topics.decisions, [decision(tx, 'REVIEW', score)]);
  return { tx, alert: await alertFor(tx.payload.transactionId) };
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('alerts_svc');
  for (const schema of ['auth', 'alerts']) {
    await migrate({ databaseUrl: url, schema, dir: repoPath(`migrations/${schema}`) });
  }
  pool = createPool({ connectionString: url, applicationName: 'test', max: 10 });
  const users = new UsersRepository();
  analystId = randomUUID();
  const hash = await hashPassword(PASSWORD);
  await users.upsertUser(pool, {
    userId: analystId,
    email: 'analyst@demo.local',
    passwordHash: hash,
    role: 'analyst',
  });
  await users.upsertUser(pool, {
    userId: randomUUID(),
    email: 'admin@demo.local',
    passwordHash: hash,
    role: 'admin',
  });
  producer = createProducer(kafka.kafka);
  await producer.connect();
  app = await createApp(
    loadConfig({
      DATABASE_URL_ALERTS: url,
      KAFKA_BROKERS: kafka.brokers.join(','),
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
      HASH_PEPPER: 'test-pepper-of-sufficient-length',
      STREAM_DECISION_SAMPLE_RATE: '1',
      STREAM_METRICS_TICK_MS: '300',
    }),
    { runtimeOverrides: { inProcessDelaysMs: [100, 200], retryBaseDelayMs: 300 } },
  );
  await app.listen(0, '0.0.0.0');
  base = `http://127.0.0.1:${String((app.getHttpServer().address() as { port: number }).port)}`;
  const token = async (email: string) =>
    (
      (
        await http('POST', '/auth/login', { body: { email, password: PASSWORD }, from: freshIp() })
      ).json() as { accessToken: string }
    ).accessToken;
  analyst = await token('analyst@demo.local');
  admin = await token('admin@demo.local');
});

afterAll(async () => {
  await app.close();
  await producer.disconnect();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('alerts from decisions (SPEC §6.8)', () => {
  it('creates one OPEN alert for a REVIEW decision delivered twice, with a masked snapshot', async () => {
    const tx = transaction('acc_rev');
    const d = decision(tx, 'REVIEW');
    await publish(Topics.transactions, [tx]);
    await publish(Topics.decisions, [d, d]);
    const alert = await alertFor(tx.payload.transactionId);
    expect(alert.status).toBe('OPEN');
    const snapshot = JSON.stringify(alert.snapshot);
    expect(snapshot).toContain(tx.payload.maskedPan);
    expect(snapshot).not.toContain(tx.payload.cardToken);
    expect(snapshot).not.toContain('ipHash');
    expect(alert.snapshot).toMatchObject({
      decision: { finalScore: 0.69, reasons: decisionFixture.payload.reasons },
    });
    await new Promise((r) => setTimeout(r, 500));
    const { rowCount } = await pool.query('SELECT 1 FROM alerts.alerts WHERE transaction_id = $1', [
      tx.payload.transactionId,
    ]);
    expect(rowCount).toBe(1);
  });

  it('creates no alert for APPROVE', async () => {
    const tx = transaction('acc_ok');
    const d = decision(tx, 'APPROVE', 0.1);
    await publish(Topics.transactions, [tx]);
    await publish(Topics.decisions, [d]);
    await processed(d.eventId);
    const { rowCount } = await pool.query('SELECT 1 FROM alerts.alerts WHERE transaction_id = $1', [
      tx.payload.transactionId,
    ]);
    expect(rowCount).toBe(0);
  });

  it('waits for the transaction when the DECLINE decision arrives first', async () => {
    const tx = transaction('acc_late');
    await publish(Topics.decisions, [decision(tx, 'DECLINE', 0.91)]);
    await new Promise((r) => setTimeout(r, 800));
    await publish(Topics.transactions, [tx]);
    expect((await alertFor(tx.payload.transactionId)).status).toBe('OPEN');
  });
});

describe('alert queue: keyset pagination', () => {
  it('pages through 250 alerts with limit=100 while new ones arrive: no duplicates, no skips', async () => {
    const account = 'acc_page';
    const insert = (n: number) =>
      pool.query(
        `INSERT INTO alerts.alerts (alert_id, transaction_id, account_id, decision, final_score, reasons, snapshot, status, created_at)
         SELECT gen_random_uuid(), gen_random_uuid(), $1, 'REVIEW', round((random() * 9)::numeric / 10, 1), '{}', '{}', 'OPEN',
                now() - (random() * interval '1 minute')
           FROM generate_series(1, $2)`,
        [account, n],
      );
    await insert(250); // scores in 10 steps: many ties, so created_at and alert_id decide order
    const { rows: initial } = await pool.query<{ alert_id: string }>(
      'SELECT alert_id FROM alerts.alerts WHERE account_id = $1',
      [account],
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `/v1/alerts?accountId=${account}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await http('GET', query, { bearer: analyst });
      expect(res.status).toBe(200);
      const page = res.json() as {
        items: { alertId: string; finalScore: string }[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((i) => i.alertId));
      cursor = page.nextCursor;
      pages++;
      await insert(20); // concurrent arrivals between pages
    } while (cursor && pages < 10);

    expect(new Set(seen).size).toBe(seen.length); // nothing twice
    const seenSet = new Set(seen);
    expect(initial.filter((r) => !seenSet.has(r.alert_id))).toEqual([]); // nothing skipped
  });

  it('orders by score desc and applies filters', async () => {
    const res = await http('GET', '/v1/alerts?minScore=0.9&limit=100', { bearer: analyst });
    const items = (res.json() as { items: { finalScore: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => Number(i.finalScore) >= 0.9)).toBe(true);
    const scores = items.map((i) => Number(i.finalScore));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('rejects a tampered cursor and invalid filters with 400', async () => {
    const first = (await http('GET', '/v1/alerts?limit=1', { bearer: analyst })).json() as {
      nextCursor: string;
    };
    const [body = '', mac = ''] = first.nextCursor.split('.');
    const forged = `${Buffer.from('["0.9999","2026-01-01T00:00:00.000000Z","00000000-0000-0000-0000-000000000000"]').toString('base64url')}.${mac}`;
    for (const q of [
      `cursor=${body}x.${mac}`,
      `cursor=${forged}`,
      'status=DELETED',
      'minScore=2',
      "accountId=a'%20OR%201=1",
      'limit=1000',
      'sort=evil',
    ]) {
      expect((await http('GET', `/v1/alerts?${q}`, { bearer: analyst })).status).toBe(400);
    }
  });
});

describe('detail, assign, resolve', () => {
  it('audits a detail view as ALERT_VIEWED', async () => {
    const { alert } = await reviewAlert('acc_view');
    const res = await http('GET', `/v1/alerts/${alert.alert_id}`, { bearer: analyst });
    expect(res.status).toBe(200);
    const detail = res.json() as { alertId: string; snapshot: unknown };
    expect(detail.alertId).toBe(alert.alert_id);
    expect(detail.snapshot).toBeTypeOf('object');
    const { rows } = await pool.query(
      "SELECT 1 FROM alerts.audit_log WHERE action = 'ALERT_VIEWED' AND target_id = $1 AND actor_id = $2",
      [alert.alert_id, analystId],
    );
    expect(rows).toHaveLength(1);
    expect((await http('GET', `/v1/alerts/${randomUUID()}`, { bearer: analyst })).status).toBe(404);
  });

  it('assigns, resolves with feedback published atomically, then refuses a second resolve', async () => {
    const { tx, alert } = await reviewAlert('acc_resolve');
    const assigned = await http('POST', `/v1/alerts/${alert.alert_id}/assign`, { bearer: analyst });
    expect(assigned.json()).toMatchObject({ status: 'IN_PROGRESS', assignedTo: analystId });

    const empty = await http('POST', `/v1/alerts/${alert.alert_id}/resolve`, {
      bearer: analyst,
      body: { verdict: 'LEGITIMATE', note: '   ' },
    });
    expect(empty.status).toBe(400);
    expect((await alertFor(tx.payload.transactionId)).status).toBe('IN_PROGRESS'); // nothing changed

    const resolved = await http('POST', `/v1/alerts/${alert.alert_id}/resolve`, {
      bearer: analyst,
      body: { verdict: 'LEGITIMATE', note: 'customer confirmed the purchase' },
    });
    expect(resolved.status).toBe(200);
    const body = resolved.json() as { status: string; resolvedAt: string | null };
    expect(body.status).toBe('LEGITIMATE');
    expect(body.resolvedAt).toBeTypeOf('string');

    const again = await http('POST', `/v1/alerts/${alert.alert_id}/resolve`, {
      bearer: analyst,
      body: { verdict: 'CONFIRMED_FRAUD', note: 'changed my mind' },
    });
    expect(again.status).toBe(409);

    const message = await waitFor(async () =>
      (await readAll(kafka.kafka, [Topics.analystFeedback])).find((m) =>
        m.value?.includes(alert.alert_id),
      ),
    );
    const event = AnalystFeedbackRecorded.envelope.parse(JSON.parse(message.value ?? ''));
    expect(event.payload).toMatchObject({
      alertId: alert.alert_id,
      transactionId: tx.payload.transactionId,
      verdict: 'LEGITIMATE',
      analystId,
      note: 'customer confirmed the purchase',
    });
    expect(message.key).toBe('acc_resolve');
    const { rows } = await pool.query(
      "SELECT metadata FROM alerts.audit_log WHERE action = 'ALERT_RESOLVED' AND target_id = $1",
      [alert.alert_id],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps the audit log append-only for alerts_svc', async () => {
    await expect(pool.query('DELETE FROM alerts.audit_log')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(pool.query("UPDATE alerts.audit_log SET action = 'X'")).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('timeline and metrics', () => {
  it('lists decisions and ledger postings of an account, newest first', async () => {
    const account = 'acc_timeline';
    const tx = transaction(account);
    await publish(Topics.transactions, [tx]);
    const d = decision(tx, 'APPROVE', 0.1);
    await publish(Topics.decisions, [d]);
    await processed(d.eventId);
    const posted = createEnvelope({
      eventType: LedgerEntriesPosted.eventType,
      eventVersion: 1,
      producer: 'ledger',
      correlationId: tx.payload.transactionId,
      payload: {
        transactionId: tx.payload.transactionId,
        accountId: account,
        journalId: randomUUID(),
        entries: [
          {
            ledgerAccount: `customer:${account}`,
            direction: 'DEBIT' as const,
            amount: '10.00',
            currency: 'BRL' as const,
          },
          {
            ledgerAccount: 'merchant:m',
            direction: 'CREDIT' as const,
            amount: '10.00',
            currency: 'BRL' as const,
          },
        ],
        postedAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await publish(Topics.ledgerEntries, [posted]);
    await processed(posted.eventId);

    const res = await http('GET', `/v1/accounts/${account}/timeline`, { bearer: analyst });
    const items = (res.json() as { items: { kind: string; amount: unknown }[] }).items;
    expect(items.map((i) => i.kind)).toEqual(['LEDGER', 'DECISION']);
    expect(
      items.every((i) => JSON.stringify(i.amount) === JSON.stringify(txFixture.payload.amount)),
    ).toBe(true);
  });

  it('shows profile, balance and activity on the account view', async () => {
    const account = 'acc_view360';
    const profile = createEnvelope({
      eventType: AccountProfileUpserted.eventType,
      eventVersion: 1,
      producer: 'simulator',
      correlationId: randomUUID(),
      payload: {
        accountId: account,
        homeCountry: 'BR' as const,
        homeCity: 'Recife',
        createdAt: new Date().toISOString(),
        riskTier: 'HIGH' as const,
        creditLimit: '5000.00',
      },
    });
    await publish(Topics.accountProfiles, [profile]);
    const tx = transaction(account);
    await publish(Topics.transactions, [tx]);
    const posting = (amount: string) =>
      createEnvelope({
        eventType: LedgerEntriesPosted.eventType,
        eventVersion: 1,
        producer: 'ledger',
        correlationId: randomUUID(),
        payload: {
          transactionId: uuidv7(),
          accountId: account,
          journalId: randomUUID(),
          entries: [
            {
              ledgerAccount: `customer:${account}`,
              direction: 'DEBIT' as const,
              amount,
              currency: 'BRL' as const,
            },
            {
              ledgerAccount: 'merchant:m',
              direction: 'CREDIT' as const,
              amount,
              currency: 'BRL' as const,
            },
          ],
          postedAt: new Date().toISOString(),
        },
      });
    const first = posting('10.10');
    const second = posting('0.20');
    const postings = [first, second];
    await publish(Topics.ledgerEntries, [first, second, first]); // one duplicate
    for (const p of [profile, tx, ...postings]) await processed(p.eventId);

    const res = await http('GET', `/v1/accounts/${account}`, { bearer: analyst });
    expect(res.json()).toMatchObject({
      accountId: account,
      profile: { homeCountry: 'BR', homeCity: 'Recife', riskTier: 'HIGH', creditLimit: '5000.00' },
      balance: { currency: 'BRL', balance: '-10.30' }, // the duplicate posting is not applied twice
      stats: { transactions: 1, averageAmount: '1250.90' },
    });
    expect(
      (await http('GET', '/v1/accounts/unknown_account', { bearer: analyst })).json(),
    ).toMatchObject({
      profile: null,
      balance: null,
    });
  });

  it('puts amount, merchant, country and fired rules on queue rows', async () => {
    const { alert } = await reviewAlert('acc_columns');
    const res = await http('GET', '/v1/alerts?accountId=acc_columns', { bearer: analyst });
    const [row] = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(row).toMatchObject({
      alertId: alert.alert_id,
      amount: txFixture.payload.amount,
      merchantName: txFixture.payload.merchant.name,
      country: txFixture.payload.merchant.country,
    });
    expect(row).not.toHaveProperty('snapshot');
  });

  it('summarizes decision rates and p95 latency for the window', async () => {
    const before = (
      await http('GET', '/v1/metrics/summary?window=1h', { bearer: analyst })
    ).json() as {
      decisions: number;
      rates: Record<string, number>;
    };
    const events = ['APPROVE', 'APPROVE', 'APPROVE', 'REVIEW', 'DECLINE'].map((o) => {
      const tx = transaction('acc_metrics');
      return { tx, d: decision(tx, o as FraudDecisionMadeV1['decision']) };
    });
    await publish(
      Topics.transactions,
      events.map((e) => e.tx),
    );
    await publish(
      Topics.decisions,
      events.map((e) => e.d),
    );
    for (const e of events) await processed(e.d.eventId);
    const after = (
      await http('GET', '/v1/metrics/summary?window=1h', { bearer: analyst })
    ).json() as {
      decisions: number;
      p95LatencyMs: number;
      transactionsPerSecond: number;
    };
    expect(after.decisions - before.decisions).toBe(5);
    expect(after.p95LatencyMs).toBeGreaterThan(100); // every fixture decision took 120 ms
    expect(after.p95LatencyMs).toBeLessThanOrEqual(200);
    expect((await http('GET', '/v1/metrics/summary?window=1y', { bearer: analyst })).status).toBe(
      400,
    );
  });
});

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

/** Opens the stream and collects parsed events until `close()`. */
function openStream(cookie: string | undefined, lastEventId?: number, viaQuery = false) {
  const events: SseEvent[] = [];
  let response: IncomingMessage | undefined;
  const url = new URL('/v1/stream', base);
  const ready = new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path:
          viaQuery && lastEventId
            ? `${url.pathname}?lastEventId=${String(lastEventId)}`
            : url.pathname,
        headers: {
          ...(cookie ? { cookie: `fs_stream=${cookie}` } : {}),
          ...(lastEventId && !viaQuery ? { 'last-event-id': String(lastEventId) } : {}),
        },
      },
      (res) => {
        response = res;
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const fields = new Map(
              frame
                .split('\n')
                .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
            );
            const data = fields.get('data');
            if (data !== undefined) {
              events.push({
                id: Number(fields.get('id')),
                event: fields.get('event') ?? '',
                data: JSON.parse(data) as Record<string, unknown>,
              });
            }
          }
        });
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  return {
    ready,
    events,
    close: () => response?.destroy(),
    waitFor: (match: (e: SseEvent) => boolean) =>
      waitFor(() => Promise.resolve(events.find(match)), 30_000),
  };
}

describe('SSE stream (SPEC §6.8, ADR-006)', () => {
  const streamCookie = async () =>
    (await http('POST', '/auth/stream-session', { bearer: analyst })).cookies.get('fs_stream')
      ?.value ?? '';

  it('refuses a client without a stream session cookie', async () => {
    const stream = openStream(undefined);
    expect(await stream.ready).toBe(401);
    stream.close();
  });

  it('pushes alert.created, sampled decision.made and metrics.tick', async () => {
    const stream = openStream(await streamCookie());
    expect(await stream.ready).toBe(200);
    const { alert } = await reviewAlert('acc_sse');
    const created = await stream.waitFor(
      (e) => e.event === 'alert.created' && e.data.alertId === alert.alert_id,
    );
    expect(created.data).not.toHaveProperty('snapshot');
    await stream.waitFor((e) => e.event === 'decision.made');
    await stream.waitFor((e) => e.event === 'metrics.tick');
    stream.close();
  });

  it('replays alerts missed during a short disconnect via Last-Event-ID', async () => {
    const cookie = await streamCookie();
    const first = openStream(cookie);
    await first.ready;
    const tick = await first.waitFor((e) => e.event === 'metrics.tick');
    first.close();

    const missed = [await reviewAlert('acc_gap1'), await reviewAlert('acc_gap2')].map(
      (a) => a.alert.alert_id,
    );
    const second = openStream(cookie, tick.id);
    expect(await second.ready).toBe(200);
    for (const id of missed)
      await second.waitFor((e) => e.event === 'alert.created' && e.data.alertId === id);
    second.close();

    // a brand-new EventSource cannot send the header: the same resume via ?lastEventId=
    const third = openStream(cookie, tick.id, true);
    expect(await third.ready).toBe(200);
    for (const id of missed)
      await third.waitFor((e) => e.event === 'alert.created' && e.data.alertId === id);
    third.close();
  });
});

describe('admin endpoints', () => {
  it('replays a DLQ range (dry run first), audited', async () => {
    const tx = transaction('acc_dlq');
    await publish(Topics.transactions, [tx]);
    await processed(tx.eventId);
    const topic = dlqTopic(Topics.decisions, 'alerts-gateway');
    await publish(topic, [decision(tx, 'REVIEW')], {
      [DlqHeaders.originalTopic]: Topics.decisions,
      [DlqHeaders.originalPartition]: '0',
      [DlqHeaders.originalOffset]: '0',
      [DlqHeaders.reason]: 'test',
    });
    const body = { topic, from: '0', to: '100', dryRun: true };
    const dry = await http('POST', '/admin/dlq/replay', { bearer: admin, body });
    expect(dry.status).toBe(200);
    expect((dry.json() as { results: { replayed: boolean }[] }).results).toEqual([
      expect.objectContaining({ replayed: false }),
    ]);

    const real = await http('POST', '/admin/dlq/replay', {
      bearer: admin,
      body: { ...body, dryRun: false },
    });
    expect((real.json() as { results: { replayed: boolean }[] }).results).toEqual([
      expect.objectContaining({ replayed: true }),
    ]);
    expect((await alertFor(tx.payload.transactionId)).status).toBe('OPEN');
    const { rows } = await pool.query(
      "SELECT metadata FROM alerts.audit_log WHERE action = 'DLQ_REPLAYED' ORDER BY id",
    );
    expect(rows).toHaveLength(2);

    expect(
      (
        await http('POST', '/admin/dlq/replay', {
          bearer: admin,
          body: { ...body, topic: 'payments.transactions.v1' },
        })
      ).status,
    ).toBe(400);
    expect((await http('POST', '/admin/dlq/replay', { bearer: analyst, body })).status).toBe(403);
    // invalid offsets are 400s, not 500s (the range refinement must not call BigInt on them)
    for (const bad of [{ from: 'abc' }, { to: "1'; --" }, { from: '5', to: '1' }]) {
      expect(
        (await http('POST', '/admin/dlq/replay', { bearer: admin, body: { ...body, ...bad } }))
          .status,
      ).toBe(400);
    }
  });

  it('reports lag for a stopped consumer group', async () => {
    const res = await http('GET', '/admin/consumers/lag', { bearer: admin });
    expect(res.status).toBe(200);
    const items = (res.json() as { items: { group: string; topic: string; lag: string }[] }).items;
    // nothing consumes as `ledger` in this test, yet decisions were published
    const ledgerLag = items
      .filter((i) => i.group === 'ledger' && i.topic === Topics.decisions)
      .reduce((sum, i) => sum + BigInt(i.lag), 0n);
    expect(ledgerLag).toBeGreaterThan(0n);
  });
});
