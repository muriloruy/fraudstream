import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, toneFor } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ScoreBar } from '../../../components/ui/score-bar';
import { Select } from '../../../components/ui/select';
import { Table, Td, Th } from '../../../components/ui/table';
import { api, unwrap } from '../../../lib/api-client';
import { cn } from '../../../lib/cn';
import { formatAge, formatMoney } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import type { AlertListItem } from '../../../lib/types';
import { useCacheValue } from '../../../lib/use-cache-value';
import { usePrincipal } from '../../auth/hooks/use-session';
import {
  DEFAULT_FILTERS,
  matches,
  toQuery,
  type QueueFilters,
  type SortOrder,
  type StatusFilter,
} from '../hooks/queue-filters';

const TOP_THRESHOLD_PX = 120;

/** Alert Queue (SPEC §8.2): filters, keyset "load more", live inserts with a new-alerts counter. */
export default function AlertQueuePage() {
  const principal = usePrincipal();
  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState({ minScore: '', accountId: '' });
  // null while the user is at the top (live alerts show at once); otherwise how many live alerts
  // were visible when they scrolled away: the newer ones wait behind the counter.
  const [frozen, setFrozen] = useState<number | null>(null);
  const client = useQueryClient();
  const tableRef = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    queryKey: keys.alertList({
      status: filters.status,
      minScore: filters.minScore,
      accountId: filters.accountId,
    }),
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/v1/alerts', { params: { query: toQuery(filters, pageParam) } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const incoming = useCacheValue<AlertListItem[]>(keys.incomingAlerts, []);

  useEffect(() => {
    const onScroll = () => {
      const atTop = window.scrollY < TOP_THRESHOLD_PX;
      const visibleNow = client.getQueryData<AlertListItem[]>(keys.incomingAlerts)?.length ?? 0;
      setFrozen((prev) => (atTop ? null : (prev ?? visibleNow)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [client]);

  const loaded = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const loadedIds = useMemo(() => new Set(loaded.map((a) => a.alertId)), [loaded]);
  const cut = frozen === null ? 0 : Math.max(0, incoming.length - frozen); // incoming is newest first
  const pending = incoming
    .slice(0, cut)
    .filter((a) => matches(a, filters) && !loadedIds.has(a.alertId));
  const live = incoming.slice(cut).filter((a) => matches(a, filters) && !loadedIds.has(a.alertId));
  const liveIds = new Set(live.map((a) => a.alertId));
  let rows = [...live, ...loaded];
  if (filters.sort === 'age')
    rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const applyText = (e: FormEvent) => {
    e.preventDefault();
    setFilters((f) => ({
      ...f,
      minScore: draft.minScore.trim(),
      accountId: draft.accountId.trim(),
    }));
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-fg">Alert queue</h1>
      <form onSubmit={applyText} className="flex flex-wrap items-end gap-3" aria-label="Filters">
        <Select
          label="Status"
          value={filters.status}
          onValueChange={(v) => {
            setFilters((f) => ({ ...f, status: v as StatusFilter }));
          }}
          options={[
            { value: 'open', label: 'Open & in progress' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Input
          label="Min score"
          inputMode="decimal"
          placeholder="0.75"
          className="w-28"
          value={draft.minScore}
          onChange={(e) => {
            setDraft((d) => ({ ...d, minScore: e.target.value }));
          }}
        />
        <Input
          label="Account"
          placeholder="acc_000123"
          className="w-44"
          value={draft.accountId}
          onChange={(e) => {
            setDraft((d) => ({ ...d, accountId: e.target.value }));
          }}
        />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Select
          label="Sort by"
          value={filters.sort}
          onValueChange={(v) => {
            setFilters((f) => ({ ...f, sort: v as SortOrder }));
          }}
          options={[
            { value: 'score', label: 'Highest score' },
            { value: 'age', label: 'Newest' },
          ]}
        />
      </form>

      {pending.length > 0 ? (
        <Button
          className="fixed left-1/2 top-16 z-20 -translate-x-1/2 shadow-lg"
          onClick={() => {
            setFrozen(incoming.length);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            tableRef.current?.focus();
          }}
        >
          {pending.length === 1 ? '1 new alert' : `${String(pending.length)} new alerts`}
        </Button>
      ) : null}

      {query.isError ? (
        <p role="alert" className="text-sm text-decline">
          Could not load alerts. {query.error.message}
        </p>
      ) : null}

      <div ref={tableRef} tabIndex={-1} aria-live="polite" aria-busy={query.isLoading}>
        <Table aria-label="Alerts">
          <thead>
            <tr>
              <Th>Score</Th>
              <Th>Decision</Th>
              <Th>Account</Th>
              <Th className="text-right">Amount</Th>
              <Th>Merchant</Th>
              <Th>Country</Th>
              <Th>Rules</Th>
              <Th>Age</Th>
              <Th>Status</Th>
              <Th>Assignee</Th>
              <Th>
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr
                key={a.alertId}
                // live inserts are highlighted once, when they mount (CSS animation)
                className={cn(liveIds.has(a.alertId) && 'animate-highlight')}
                data-testid="alert-row"
              >
                <Td>
                  <ScoreBar score={Number(a.finalScore)} />
                </Td>
                <Td>
                  <Badge tone={toneFor(a.decision)}>{a.decision}</Badge>
                </Td>
                <Td>
                  <Link
                    to={`/accounts/${a.accountId}`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {a.accountId}
                  </Link>
                </Td>
                <Td className="text-right tabular-nums">{formatMoney(a.amount)}</Td>
                <Td className="max-w-40 truncate">{a.merchantName ?? '—'}</Td>
                <Td>{a.country ?? '—'}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.firedRules.map((r) => (
                      <Badge key={r}>{r}</Badge>
                    ))}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-fg-muted">{formatAge(a.createdAt)}</Td>
                <Td>
                  <Badge tone={toneFor(a.status)}>{a.status.replace('_', ' ')}</Badge>
                </Td>
                <Td className="text-fg-muted">
                  {a.assignedTo
                    ? a.assignedTo === principal?.userId
                      ? 'me'
                      : a.assignedTo.slice(0, 8)
                    : '—'}
                </Td>
                <Td>
                  <Link
                    to={`/alerts/${a.alertId}`}
                    className="text-primary underline-offset-2 hover:underline"
                    aria-label={`Open alert for ${a.accountId}, score ${a.finalScore}`}
                  >
                    Open
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!query.isLoading && rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">No alerts match these filters.</p>
        ) : null}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
