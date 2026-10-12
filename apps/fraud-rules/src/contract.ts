/** Event builders exposed to the cross-service contract tests (SPEC §13.3). */
export { PRODUCER, toFacts, toResult } from './application/evaluate-transaction.js';
export { loadRuleset } from './config/ruleset-loader.js';
export { evaluate, type RuleContext } from './domain/rules.js';
