/**
 * `pnpm env:init` — creates .env from .env.example, replacing every placeholder secret
 * with a fresh random value. Refuses to overwrite an existing .env.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = `${root}.env`;
if (existsSync(target)) {
  console.error('.env already exists; delete it first to regenerate secrets');
  process.exit(1);
}

const password = randomBytes(18).toString('base64url');
const lines = readFileSync(`${root}.env.example`, 'utf8')
  .split('\n')
  .map((line) => {
    if (line.startsWith('#') || !line.includes('=')) return line;
    const [name = '', value = ''] = line.split(/=(.*)/s);
    if (value.startsWith('base64:REPLACE')) {
      return `${name}=base64:${randomBytes(32).toString('base64')}`;
    }
    if (name.startsWith('DATABASE_URL_')) return line.replace(':change-me@', `:${password}@`);
    if (value === 'change-me') return `${name}=${randomBytes(24).toString('base64url')}`;
    return line;
  });
writeFileSync(target, lines.join('\n'));
console.log('wrote .env with freshly generated secrets');
