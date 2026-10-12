import { z } from 'zod';
import { AccountId, UtcDateTime, Uuid, UuidV7 } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const Verdict = z.enum(['CONFIRMED_FRAUD', 'LEGITIMATE']);
export type Verdict = z.infer<typeof Verdict>;

/** `fraud.analyst-feedback.v1` (SPEC §4.9). */
export const AnalystFeedbackRecordedV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  alertId: Uuid,
  verdict: Verdict,
  analystId: z.string().min(1).max(64),
  note: z.string().min(1).max(2000),
  recordedAt: UtcDateTime,
});
export type AnalystFeedbackRecordedV1 = z.infer<typeof AnalystFeedbackRecordedV1>;

export const AnalystFeedbackRecorded = defineEvent({
  eventType: 'AnalystFeedbackRecorded',
  eventVersion: 1,
  topic: Topics.analystFeedback,
  payload: AnalystFeedbackRecordedV1,
});
