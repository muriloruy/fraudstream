/** Event builders exposed to the cross-service contract tests (SPEC §13.3). */
export { PRODUCER, toDecisionEvent } from './application/decider.js';
export { decide, DEFAULT_FUSION } from './domain/fusion.js';
