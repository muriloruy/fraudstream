import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { RulesetFile, toRuleset, type Ruleset } from '../domain/ruleset.js';

/** apps/fraud-rules/rules.yaml, from both src/ (tests) and dist/ (runtime). */
export const DEFAULT_RULES_FILE = fileURLToPath(new URL('../../rules.yaml', import.meta.url));

/** Parses and validates a ruleset; a broken file stops the service at boot. */
export function parseRuleset(text: string): Ruleset {
  const parsed = RulesetFile.safeParse(parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid ruleset: ${issues.join('; ')}`);
  }
  return toRuleset(parsed.data);
}

export function loadRuleset(path: string = DEFAULT_RULES_FILE): Ruleset {
  // The path comes from configuration, not from requests.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return parseRuleset(readFileSync(path, 'utf8'));
}
