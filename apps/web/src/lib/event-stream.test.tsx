import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { alertItem, summary } from '../test/fixtures';
import { analyst, mockFetch, newClient, on } from '../test/utils';
import {
  applyStreamEvent,
  MAX_FEED,
  TICK_WINDOW_MS,
  useEventStream,
  type Tick,
} from './event-stream';
import { keys } from './query-keys';
import { session } from './session';
import type { AlertListItem, DecisionMade } from './types';

afterEach(() => {
  session.clear();
});

describe('applyStreamEvent', () => {
  it('prepends new alerts once and patches updated ones', () => {
    const client = newClient();
    const a = alertItem();
    applyStreamEvent(client, 'alert.created', a);
    applyStreamEvent(client, 'alert.created', a); // duplicate after a resume
    applyStreamEvent(client, 'alert.updated', {
      ...a,
      status: 'IN_PROGRESS',
      assignedTo: analyst.userId,
    });
    expect(client.getQueryData<AlertListItem[]>(keys.incomingAlerts)).toEqual([
      expect.objectContaining({ alertId: a.alertId, status: 'IN_PROGRESS' }),
    ]);
  });

  it('keeps at most 200 decisions and 15 minutes of ticks', () => {
    const client = newClient();
    for (let i = 0; i < MAX_FEED + 5; i++) {
      applyStreamEvent(client, 'decision.made', { transactionId: String(i) }); // data is unknown on the wire
    }
    expect(client.getQueryData<DecisionMade[]>(keys.decisionFeed)).toHaveLength(MAX_FEED);
    const t0 = 1_000_000_000;
    applyStreamEvent(client, 'metrics.tick', summary(), t0);
    applyStreamEvent(client, 'metrics.tick', summary(), t0 + TICK_WINDOW_MS + 1);
    expect(client.getQueryData<Tick[]>(keys.ticks)?.map((t) => t.at)).toEqual([
      t0 + TICK_WINDOW_MS + 1,
    ]);
  });
});

/** Minimal EventSource double: tests drive its events. */
class FakeSource {
  static instances: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown, id: string) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }
  close() {
    this.readyState = 2;
  }
}

describe('useEventStream', () => {
  it('opens one stream with a session cookie, dispatches events and resumes with lastEventId', async () => {
    FakeSource.instances = [];
    session.set('token', analyst);
    const { calls } = mockFetch(
      on('POST', '/auth/stream-session', () => new Response(null, { status: 204 })),
    );
    const client = newClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const make = (url: string) => new FakeSource(url) as unknown as EventSource;
    const { result } = renderHook(() => useEventStream(true, make), { wrapper });

    await waitFor(() => {
      expect(FakeSource.instances).toHaveLength(1);
    });
    const first = FakeSource.instances[0];
    if (!first) throw new Error('no source');
    expect(first.url).toBe('/v1/stream');
    act(() => {
      first.onopen?.();
      first.emit('alert.created', alertItem({ alertId: 'a1' }), '42');
    });
    expect(result.current).toBe('open');
    expect(client.getQueryData<AlertListItem[]>(keys.incomingAlerts)?.[0]?.alertId).toBe('a1');

    // the server ended the expired session and the browser gave up: new cookie, resume at 42
    act(() => {
      first.close();
      first.onerror?.();
    });
    expect(result.current).toBe('reconnecting');
    await waitFor(
      () => {
        expect(FakeSource.instances).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    expect(FakeSource.instances[1]?.url).toBe('/v1/stream?lastEventId=42');
    expect(calls.filter((c) => c.url.endsWith('/auth/stream-session'))).toHaveLength(2);
  });
});
