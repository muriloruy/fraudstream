/**
 * `pnpm sim:seed` and `pnpm sim:run` (SPEC §6.9). Reads the repository `.env`.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKafka, createProducer, parseBrokers } from '@fraudstream/kafka';
import { seed } from './application/seed.js';
import { GROUND_TRUTH_HEADER, groundTruthLine, httpSender, runTraffic } from './application/run.js';
import { parseArgs } from './cli.js';
import { Random } from './domain/random.js';
import { planRun } from './domain/traffic.js';
import { buildWorld } from './domain/world.js';
import { createSimulatorApiKey } from './infrastructure/api-key.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = resolve(repoRoot, '.env');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo .env
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = parseArgs(process.argv.slice(2));

if (args.command === 'seed') {
  const pepper = process.env.HASH_PEPPER;
  if (!pepper) throw new Error('HASH_PEPPER is not set (run pnpm env:init)');
  const kafka = createKafka({
    brokers: parseBrokers(process.env.KAFKA_BROKERS),
    clientId: 'simulator-seed',
  });
  const producer = createProducer(kafka);
  await producer.connect();
  try {
    const started = Date.now();
    const result = await seed(producer, {
      accounts: args.accounts,
      seed: args.seed,
      days: args.days,
      hashPepper: pepper,
      onProgress: ({ profiles, transactions }) => {
        process.stdout.write(`\rprofiles ${profiles}, history transactions ${transactions}`);
      },
    });
    console.log(
      `\nseeded ${result.profiles} accounts and ${result.transactions} historical transactions ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)} s. The pipeline builds the baselines ` +
        'as it consumes them: wait for consumer lag 0 (kafka-ui or Grafana) before sim:run.',
    );
  } finally {
    await producer.disconnect();
  }
} else {
  const apiUrl = process.env.SIM_API_URL ?? 'http://localhost:3000';
  let apiKey = process.env.SIM_API_KEY;
  if (!apiKey) {
    const url = process.env.DATABASE_URL_PAYMENTS;
    if (!url) throw new Error('set SIM_API_KEY or DATABASE_URL_PAYMENTS');
    apiKey = await createSimulatorApiKey(url);
  }
  const world = buildWorld(args.seed, args.accounts);
  const plan = planRun(new Random(args.seed).fork(`run-${Date.now()}`), world, {
    tps: args.tps,
    durationSeconds: args.durationSeconds,
    fraudRate: args.fraudRate,
    ...(args.scenario ? { scenario: args.scenario } : {}),
  });

  const out = resolve(repoRoot, args.out);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI output path
  mkdirSync(dirname(out), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI output path
  const file = createWriteStream(out, { flags: 'w' });
  file.write(`${GROUND_TRUTH_HEADER}\n`);

  console.log(
    `sending ${plan.length} transactions at ${args.tps} tps to ${apiUrl} ` +
      `(${plan.filter((t) => t.isFraud).length} fraud${args.scenario ? `, ${args.scenario} only` : ''})`,
  );
  const stats = await runTraffic({
    tps: args.tps,
    plan,
    send: httpSender(apiUrl, apiKey),
    onAccepted: (row) => file.write(`${groundTruthLine(row)}\n`),
    onProgress: (s) => {
      const rate = s.sent / (s.elapsedMs / 1000);
      process.stdout.write(
        `\rsent ${s.sent}/${s.planned}, accepted ${s.accepted}, ${rate.toFixed(1)} tx/s`,
      );
    },
  });
  await new Promise<void>((done) => file.end(done));
  const seconds = stats.elapsedMs / 1000;
  console.log(
    `\nsent ${stats.sent} in ${seconds.toFixed(1)} s (${(stats.sent / seconds).toFixed(1)} tx/s), ` +
      `accepted ${stats.accepted}, rejected ${JSON.stringify(stats.rejected)}; ` +
      `ground truth: ${out}`,
  );
  if (stats.maxLagMs > 1000) {
    console.warn(`the run fell behind schedule by up to ${(stats.maxLagMs / 1000).toFixed(1)} s`);
  }
  if (stats.accepted < stats.sent) process.exitCode = 1;
}
