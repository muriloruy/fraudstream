/** Event builders exposed to the cross-service contract tests (SPEC §13.3). */
export { PRODUCER, toObservation, toScored } from './application/handlers.js';
export { MODEL_VERSION, score, update, type Baseline } from './domain/scoring.js';
