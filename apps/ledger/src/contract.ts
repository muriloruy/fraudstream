/** Event builders exposed to the cross-service contract tests (SPEC §13.3). */
export { PRODUCER, toPostedEvent } from './application/posting.js';
export { buildJournal } from './domain/journal.js';
