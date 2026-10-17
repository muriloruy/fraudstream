import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { createPool, type Pool } from '@fraudstream/db';
import {
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** A span as received over OTLP/HTTP JSON, with the name of the service that sent it. */
interface ReceivedSpan {
  service: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
}

interface OtlpBody {
  resourceSpans?: {
    resource?: { attributes?: { key: string; value: { stringValue?: string } }[] };
    scopeSpans?: { spans?: Omit<ReceivedSpan, 'service'>[] }[];
  }[];
}

let db: TestPostgres;
let kafka: TestKafka;
let collector: Server;
let payments: Pool;
let decisions: Pool;
let apiUrl: string;
let apiKey: string;
const spans: ReceivedSpan[] = [];
const services: { name: string; child: ChildProcess; output: string[] }[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

/** A minimal OTLP/HTTP JSON receiver standing in for Jaeger. */
async function startCollector(): Promise<string> {
  collector = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as OtlpBody;
      for (const rs of body.resourceSpans ?? []) {
        const service =
          rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value.stringValue ?? '';
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) spans.push({ ...span, service });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
}

/** Starts a service's build with the tracing preload, exactly as the container does. */
function spawnService(name: string, env: Record<string, string>) {
  const output: string[] = [];
  const child = spawn(
    process.execPath,
    ['--import', '@fraudstream/observability/register', 'dist/main.js'],
    {
      // Bare `--import` specifiers resolve from the working directory: the app's own deps.
      cwd: repoPath(`apps/${name}`),
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'development',
        MIGRATE_ON_START: 'true',
        OTEL_SERVICE_NAME: name,
        OTEL_BSP_SCHEDULE_DELAY: '200',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (c: Buffer) => output.push(c.toString()));
  child.stderr.on('data', (c: Buffer) => output.push(c.toString()));
  const service = { name, child, output };
  services.push(service);
  return service;
}

async function waitReady(service: (typeof services)[number], url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.name} exited:\n${service.output.join('').slice(-2000)}`);
    }
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${service.name} not ready:\n${service.output.join('').slice(-2000)}`);
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const endpoint = await startCollector();
  const common = {
    KAFKA_BROKERS: kafka.brokers.join(','),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };
  const serviceToken = randomBytes(24).toString('base64url');
  const [vaultPort, apiPort, relayPort, rulesPort, scorerPort, decisionPort] = await Promise.all(
    Array.from({ length: 6 }, () => freePort()),
  );

  const vault = spawnService('card-vault', {
    ...common,
    PORT: String(vaultPort),
    DATABASE_URL_VAULT: db.urlFor('vault_svc'),
    VAULT_DEK_V1: `base64:${randomBytes(32).toString('base64')}`,
    VAULT_HMAC_KEY: `base64:${randomBytes(32).toString('base64')}`,
    VAULT_SERVICE_TOKEN: serviceToken,
    VAULT_ADMIN_TOKEN: randomBytes(24).toString('base64url'),
  });
  await waitReady(vault, `http://127.0.0.1:${vaultPort}/health/ready`);
  const api = spawnService('transaction-api', {
    ...common,
    PORT: String(apiPort),
    DATABASE_URL_PAYMENTS: db.urlFor('payments_svc'),
    VAULT_URL: `http://127.0.0.1:${vaultPort}`,
    VAULT_SERVICE_TOKEN: serviceToken,
    HASH_PEPPER: randomBytes(24).toString('base64url'),
  });
  await waitReady(api, `http://127.0.0.1:${apiPort}/health/ready`);
  const ready = [
    [
      spawnService('outbox-relay', {
        ...common,
        RELAY_SCHEMA: 'payments',
        DATABASE_URL_PAYMENTS: db.urlFor('payments_svc'),
        METRICS_PORT: String(relayPort),
      }),
      relayPort,
    ],
    [
      spawnService('fraud-rules', {
        ...common,
        PORT: String(rulesPort),
        DATABASE_URL_FRAUD_RULES: db.urlFor('fraud_rules_svc'),
      }),
      rulesPort,
    ],
    [
      spawnService('anomaly-scorer', {
        ...common,
        PORT: String(scorerPort),
        DATABASE_URL_ANOMALY: db.urlFor('anomaly_svc'),
      }),
      scorerPort,
    ],
    [
      spawnService('decision-engine', {
        ...common,
        PORT: String(decisionPort),
        DATABASE_URL_DECISION: db.urlFor('decision_svc'),
      }),
      decisionPort,
    ],
  ] as const;
  await Promise.all(
    ready.map(([service, port]) => waitReady(service, `http://127.0.0.1:${port}/health/ready`)),
  );

  apiUrl = `http://127.0.0.1:${apiPort}`;
  payments = createPool({ connectionString: db.urlFor('payments_svc'), applicationName: 'test' });
  decisions = createPool({ connectionString: db.urlFor('decision_svc'), applicationName: 'test' });
  apiKey = `fsk_${randomBytes(32).toString('base64url')}`;
  await payments.query(
    `INSERT INTO api_keys (key_id, name, key_hash) VALUES (gen_random_uuid(), 'trace-test', $1)`,
    [createHash('sha256').update(apiKey).digest('hex')],
  );
});

afterAll(async () => {
  for (const { child } of services) child.kill('SIGTERM');
  await Promise.all([payments.end(), decisions.end()]);
  await new Promise((resolve) => collector.close(resolve));
  await Promise.all([kafka.stop(), db.stop()]);
});

describe('distributed tracing across Kafka (SPEC §10)', () => {
  it('puts every hop from the API to the decision in one trace', async () => {
    const res = await fetch(`${apiUrl}/v1/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        accountId: 'acc_trace_1',
        card: { pan: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' },
        amount: { value: '89.90', currency: 'BRL' },
        merchant: { id: 'mer_1', name: 'Loja', mcc: '5411', country: 'BR', city: 'São Paulo' },
        channel: 'POS',
        entryMode: 'CHIP',
        device: { ip: '203.0.113.10', deviceId: 'd-1' },
        geo: { lat: -23.55, lon: -46.63 },
      }),
    });
    expect(res.status).toBe(202);
    const { transactionId } = (await res.json()) as { transactionId: string };

    await waitFor(async () => {
      const { rowCount } = await decisions.query(
        'SELECT 1 FROM decisions WHERE transaction_id = $1',
        [transactionId],
      );
      return rowCount ? true : undefined;
    });

    const root = await waitFor(() =>
      spans.find(
        (s) => s.service === 'transaction-api' && s.name.startsWith('POST') && !s.parentSpanId,
      ),
    );
    const expected = [
      'transaction-api',
      'outbox-relay',
      'fraud-rules',
      'anomaly-scorer',
      'decision-engine',
    ];
    const trace = await waitFor(() => {
      const inTrace = spans.filter((s) => s.traceId === root.traceId);
      const seen = new Set(inTrace.map((s) => s.service));
      const published = inTrace.some(
        (s) => s.service === 'decision-engine' && s.name === 'publish fraud.decisions.v1',
      );
      return expected.every((name) => seen.has(name)) && published ? inTrace : undefined;
    });

    // The Kafka hops are linked parent -> child, not just sharing an id.
    const byId = new Map(trace.map((s) => [s.spanId, s]));
    const consume = trace.filter((s) => s.name.startsWith('process '));
    expect(consume.length).toBeGreaterThanOrEqual(4);
    for (const span of consume) {
      expect(byId.get(span.parentSpanId)?.name).toMatch(/^publish /);
    }
    expect(trace.some((s) => s.service === 'fraud-rules' && /SELECT|INSERT|pg/.test(s.name))).toBe(
      true,
    );
  });
});
