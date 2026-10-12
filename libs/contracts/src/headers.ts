/** Headers every message carries (SPEC §4.2). */
export const EventHeaders = {
  eventId: 'event-id',
  eventType: 'event-type',
  eventVersion: 'event-version',
  correlationId: 'correlation-id',
  causationId: 'causation-id',
  traceparent: 'traceparent',
  producer: 'producer',
} as const;

/** Headers added on retry topics (SPEC §4.6). */
export const RetryHeaders = {
  retryCount: 'retry-count',
  retryAfter: 'retry-after',
} as const;

/** Diagnostic headers added to DLQ messages (SPEC §4.6). */
export const DlqHeaders = {
  reason: 'dlq-reason',
  errorMessage: 'dlq-error-message',
  originalTopic: 'original-topic',
  originalPartition: 'original-partition',
  originalOffset: 'original-offset',
  failedAt: 'failed-at',
} as const;
