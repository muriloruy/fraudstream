/**
 * `pnpm migrations:add-inbox <service>` — copies migrations/_templates/processed_events.sql into
 * migrations/<service>/ as the next numbered migration (SPEC §4.4).
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../migrations/', import.meta.url));
const service = process.argv[2];
if (!service || !/^[a-z_]+$/.test(service)) {
  console.error('usage: pnpm migrations:add-inbox <service>   (e.g. fraud_rules)');
  process.exit(2);
}
const dir = `${root}${service}`;
if (!existsSync(dir)) {
  console.error(`migrations/${service} does not exist`);
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
if (files.some((f) => f.endsWith('_processed_events.sql'))) {
  console.log(`migrations/${service} already has a processed_events migration`);
  process.exit(0);
}
const next = Math.max(0, ...files.map((f) => Number.parseInt(f, 10) || 0)) + 1;
const target = `${dir}/${String(next).padStart(3, '0')}_processed_events.sql`;
copyFileSync(`${root}_templates/processed_events.sql`, target);
console.log(`created ${target.slice(root.length - 'migrations/'.length)}`);
