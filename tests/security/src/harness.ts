import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createPool, type Pool } from '@fraudstream/db';
import {
  repoPath,
  REPO_ROOT,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';

export interface Stack {
  db: TestPostgres;
  kafka: TestKafka;
  apiUrl: string;
  apiKey: string;
  payments: Pool;
  /** Everything the three service processes wrote to stdout and stderr. */
  logs(): string;
  stop(): Promise<void>;
}

interface Service {
  name: string;
  process: ChildProcess;
  output: string[];
}

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

/**
 * Runs a service's compiled entry point (`dist/main.js`, built by `pnpm test:security`) as its
 * own process, exactly as the container does.
 */
function spawnService(name: string, env: Record<string, string>): Service {
  const child = spawn(process.execPath, [repoPath(`apps/${name}/dist/main.js`)], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'development', LOG_LEVEL: 'trace', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return { name, process: child, output };
}

async function waitReady(service: Service, url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.process.exitCode !== null) {
      throw new Error(`${service.name} exited:\n${service.output.join('').slice(-2000)}`);
    }
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${service.name} not ready:\n${service.output.join('').slice(-2000)}`);
}

async function stopService(service: Service): Promise<void> {
  const running = () => service.process.exitCode === null && service.process.signalCode === null;
  if (!running()) return;
  const exited = new Promise((resolve) => service.process.once('exit', resolve));
  service.process.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (running()) service.process.kill('SIGKILL');
}

/**
 * The real ingestion path: card-vault, transaction-api and outbox-relay started from their
 * own entry points with trace-level logging, against PostgreSQL and Kafka containers.
 */
export async function startStack(): Promise<Stack> {
  const [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const [vaultPort, apiPort, relayPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const serviceToken = randomBytes(24).toString('base64url');
  const common = { KAFKA_BROKERS: kafka.brokers.join(','), MIGRATE_ON_START: 'true' };

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

  const relay = spawnService('outbox-relay', {
    ...common,
    RELAY_SCHEMA: 'payments',
    DATABASE_URL_PAYMENTS: db.urlFor('payments_svc'),
    METRICS_PORT: String(relayPort),
  });
  await waitReady(relay, `http://127.0.0.1:${relayPort}/health/ready`);

  const payments = createPool({
    connectionString: db.urlFor('payments_svc'),
    applicationName: 'test',
  });
  const apiKey = `fsk_${randomBytes(32).toString('base64url')}`;
  await payments.query(
    `INSERT INTO api_keys (key_id, name, key_hash) VALUES (gen_random_uuid(), 'security-tests', $1)`,
    [createHash('sha256').update(apiKey).digest('hex')],
  );

  const services = [relay, api, vault];
  return {
    db,
    kafka,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    apiKey,
    payments,
    logs: () => services.flatMap((s) => s.output).join(''),
    async stop() {
      for (const service of services) await stopService(service);
      await payments.end();
      await Promise.all([db.stop(), kafka.stop()]);
    },
  };
}

/**
 * Finds occurrences of `secret` as a standalone token: not inside a longer run of hex
 * digits or dashes (UUIDs, hashes, timestamps), which would be coincidences, not leaks.
 */
export function findLeaks(haystack: string, secret: string): string[] {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from a test constant
  const pattern = new RegExp(`(?<![0-9a-fA-F-])${escaped}(?![0-9a-fA-F-])`, 'g');
  return [...haystack.matchAll(pattern)].map((m) => {
    const start = Math.max(0, m.index - 40);
    return haystack.slice(start, m.index + secret.length + 40);
  });
}
