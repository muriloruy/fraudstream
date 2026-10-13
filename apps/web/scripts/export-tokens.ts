/**
 * `pnpm --filter @fraudstream/web tokens:export` — writes the design tokens as Tokens Studio
 * JSON (docs/frontend/tokens-studio.json) to create or sync the Figma variables (SPEC §8.1).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toTokensStudio } from '../src/styles/tokens';

const target = fileURLToPath(new URL('../../../docs/frontend/tokens-studio.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(toTokensStudio(), null, 2)}\n`);
console.log(`wrote ${target}`);
