/** A server-sent event as the gateway emits it (SPEC §6.8). */
export interface StreamEvent {
  id: number;
  type: 'alert.created' | 'alert.updated' | 'decision.made' | 'metrics.tick';
  data: unknown;
}

const isAlert = (e: StreamEvent) => e.type.startsWith('alert.');

/**
 * Per-connection outgoing queue (backpressure, SPEC §6.8): when it is full, `decision.made`
 * samples and stale `metrics.tick`s are dropped (oldest first, then the newcomer); `alert.*`
 * events are never dropped, so the queue may exceed `limit` by alerts only.
 */
export class StreamQueue {
  private readonly items: StreamEvent[] = [];
  dropped = 0;

  constructor(readonly limit = 500) {}

  get size(): number {
    return this.items.length;
  }

  push(event: StreamEvent): void {
    if (this.items.length >= this.limit) {
      const victim = this.items.findIndex((e) => !isAlert(e));
      if (victim >= 0) {
        this.items.splice(victim, 1);
        this.dropped++;
      } else if (!isAlert(event)) {
        this.dropped++;
        return;
      }
    }
    this.items.push(event);
  }

  shift(): StreamEvent | undefined {
    return this.items.shift();
  }
}

/**
 * The last `capacity` alert events, for `Last-Event-ID` resume. Ids increase monotonically per
 * process; a client that missed more than the buffer holds simply reloads the queue over REST.
 */
export class AlertRingBuffer {
  private readonly events: StreamEvent[] = [];

  constructor(readonly capacity = 1000) {}

  add(event: StreamEvent): void {
    if (!isAlert(event)) return;
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
  }

  /** Alert events with an id greater than `lastEventId`, oldest first. */
  since(lastEventId: number): StreamEvent[] {
    return this.events.filter((e) => e.id > lastEventId);
  }
}

/** SSE wire format; data is JSON on one line, so it can never inject fields or events. */
export function formatSse(event: StreamEvent): string {
  return `id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
