import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api-client';
import { keys } from './query-keys';
import { session } from './session';
import type { AlertDetail, AlertListItem, AlertPage, DecisionMade, Summary } from './types';

export const MAX_FEED = 200; // decision feed rows (SPEC §8.2)
export const TICK_WINDOW_MS = 15 * 60 * 1000; // live chart window

export interface Tick extends Summary {
  at: number;
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Applies one server-sent event to the query cache (exported for tests). */
export function applyStreamEvent(
  client: QueryClient,
  type: string,
  data: unknown,
  now = Date.now(),
): void {
  switch (type) {
    case 'alert.created': {
      const alert = data as AlertListItem;
      client.setQueryData<AlertListItem[]>(keys.incomingAlerts, (prev = []) =>
        prev.some((a) => a.alertId === alert.alertId) ? prev : [alert, ...prev],
      );
      return;
    }
    case 'alert.updated': {
      const alert = data as AlertListItem;
      const patch = (a: AlertListItem) => (a.alertId === alert.alertId ? { ...a, ...alert } : a);
      client.setQueriesData<InfiniteData<AlertPage>>({ queryKey: ['alerts', 'list'] }, (old) =>
        old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map(patch) })) } : old,
      );
      client.setQueryData<AlertListItem[]>(keys.incomingAlerts, (prev) => prev?.map(patch));
      client.setQueryData<AlertDetail>(keys.alertDetail(alert.alertId), (old) =>
        old ? { ...old, status: alert.status, assignedTo: alert.assignedTo } : old,
      );
      return;
    }
    case 'decision.made':
      client.setQueryData<DecisionMade[]>(keys.decisionFeed, (prev = []) =>
        [data as DecisionMade, ...prev].slice(0, MAX_FEED),
      );
      return;
    case 'metrics.tick':
      client.setQueryData<Tick[]>(keys.ticks, (prev = []) =>
        [...prev, { ...(data as Summary), at: now }].filter((t) => t.at >= now - TICK_WINDOW_MS),
      );
      return;
    default:
      return;
  }
}

const EVENT_TYPES = ['alert.created', 'alert.updated', 'decision.made', 'metrics.tick'] as const;

/**
 * One SSE connection per tab (ADR-006). Auth is the httpOnly `fs_stream` cookie issued by
 * POST /auth/stream-session; the browser sends it with EventSource, no token in the URL.
 * On error (network, or the server closing an expired session) it gets a new session cookie
 * and reconnects with backoff; EventSource resends Last-Event-ID to resume missed alerts.
 */
/** Module-level, so it is the same function on every render (it is an effect dependency). */
const browserSource = (url: string) => new EventSource(url, { withCredentials: true });

export function useEventStream(
  enabled: boolean,
  makeSource: (url: string) => EventSource = browserSource,
): StreamStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let lastEventId: string | null = null;

    const connect = async () => {
      const ok = session.token !== null && (await api.POST('/auth/stream-session')).response.ok;
      if (stopped) return;
      if (!ok) {
        schedule();
        return;
      }
      // A new EventSource cannot send Last-Event-ID; the gateway accepts it as a query param.
      source = makeSource(
        lastEventId ? `/v1/stream?lastEventId=${encodeURIComponent(lastEventId)}` : '/v1/stream',
      );
      source.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      source.onerror = () => {
        // CONNECTING: the browser reconnects by itself (with Last-Event-ID). CLOSED: it gave up,
        // typically a 401 once the 15-minute stream session expired: get a new one.
        if (source?.readyState !== 2 /* EventSource.CLOSED */) {
          setStatus('reconnecting');
          return;
        }
        setStatus('reconnecting');
        schedule();
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (e) => {
          const message = e as MessageEvent<string>;
          if (message.lastEventId) lastEventId = message.lastEventId;
          applyStreamEvent(client, type, JSON.parse(message.data));
        });
      }
    };
    const schedule = () => {
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      setStatus('closed');
    };
  }, [enabled, client, makeSource]);

  return status;
}
