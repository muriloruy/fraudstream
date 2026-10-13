import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ProblemException } from '@fraudstream/http';
import { formatSse, StreamQueue } from '../../domain/stream-queue.js';
import type { Gateway } from '../../gateway.js';
import { STREAM_COOKIE } from './auth.controller.js';
import { readCookie, type GatewayRequest } from './auth.guard.js';
import { GATEWAY } from './tokens.js';

interface StreamResponse {
  writableNeedDrain: boolean;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'drain' | 'close', listener: () => void): void;
}

function lastEventIdQuery(req: GatewayRequest): string | undefined {
  const value = req.query?.lastEventId;
  return typeof value === 'string' ? value : undefined;
}

/** Per-connection backlog before decision samples are dropped (SPEC §6.8 backpressure). */
const QUEUE_LIMIT = 500;

/**
 * `GET /v1/stream` (SPEC §6.8, ADR-006): server-sent events authenticated by the httpOnly
 * `fs_stream` cookie from `POST /auth/stream-session`, never by a token in the URL.
 * Writes go through a bounded per-connection queue: when the socket stops draining, decision
 * samples are dropped and alerts are kept. `Last-Event-ID` replays missed alert events.
 */
@Controller('v1/stream')
export class StreamController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  @Get()
  async stream(@Req() req: GatewayRequest, @Res() res: StreamResponse): Promise<void> {
    const token = readCookie(req, STREAM_COOKIE);
    const principal = token ? await this.gateway.tokens.verifyStream(token) : null;
    if (!principal)
      throw ProblemException.of(401, 'Unauthorized', 'missing or invalid stream session');

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer the stream
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const queue = new StreamQueue(QUEUE_LIMIT);
    const pump = () => {
      while (!res.writableNeedDrain) {
        const event = queue.shift();
        if (!event) return;
        res.write(formatSse(event));
      }
    };
    // EventSource resends Last-Event-ID on its own reconnects; a client that had to open a new
    // EventSource (expired session) passes it as ?lastEventId= instead (a position, not a secret).
    const lastEventId = Number(req.headers['last-event-id'] ?? lastEventIdQuery(req));
    if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
      for (const missed of this.gateway.bus.missedAlerts(lastEventId)) queue.push(missed);
    }
    const subscription = this.gateway.bus.subscribe((event) => {
      queue.push(event);
      pump();
    });
    res.on('drain', pump);
    // The session was checked once; end the stream when it would have expired so the client
    // must get a new one (EventSource reconnects, the dashboard re-issues the cookie).
    const expiry = setTimeout(() => {
      res.end();
    }, this.gateway.config.streamSessionTtlMs);
    expiry.unref();
    res.on('close', () => {
      clearTimeout(expiry);
      subscription.unsubscribe();
    });
    pump();
  }
}
