import { Subject, type Subscription } from 'rxjs';
import { AlertRingBuffer, type StreamEvent } from '../domain/stream-queue.js';

/**
 * In-process fan-out of stream events (one per gateway instance; multi-instance fan-out via
 * Postgres LISTEN/NOTIFY is future work, ADR-006). Ids start at the boot time in ms so they
 * keep increasing across restarts and `Last-Event-ID` stays meaningful.
 */
export class EventBus {
  private seq = Date.now();
  private readonly subject = new Subject<StreamEvent>();
  private readonly ring = new AlertRingBuffer(1000);

  publish(type: StreamEvent['type'], data: unknown): StreamEvent {
    const event: StreamEvent = { id: ++this.seq, type, data };
    this.ring.add(event);
    this.subject.next(event);
    return event;
  }

  subscribe(listener: (event: StreamEvent) => void): Subscription {
    return this.subject.subscribe(listener);
  }

  /** Alert events after `lastEventId` still in the ring buffer (reconnection). */
  missedAlerts(lastEventId: number): StreamEvent[] {
    return this.ring.since(lastEventId);
  }
}
