import { useQuery } from '@tanstack/react-query';
import { Card, CardTitle } from '../../../components/ui/card';
import { api, unwrap } from '../../../lib/api-client';
import type { Tick } from '../../../lib/event-stream';
import { formatPercent } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import type { DecisionMade, Summary } from '../../../lib/types';
import { useCacheValue } from '../../../lib/use-cache-value';
import { usePrincipal } from '../../auth/hooks/use-session';
import { DecisionFeed } from './decision-feed';
import { KpiCard } from './kpi-card';
import { LiveChart } from './live-chart';

/** Live Monitor (SPEC §8.2): KPIs and chart from metrics.tick, feed from decision.made. */
export default function MonitorPage() {
  const principal = usePrincipal();
  const ticks = useCacheValue<Tick[]>(keys.ticks, []);
  const feed = useCacheValue<DecisionMade[]>(keys.decisionFeed, []);
  // Until the first tick arrives, show the last minute from REST.
  const initial = useQuery({
    queryKey: keys.summary('60s'),
    queryFn: () => unwrap(api.GET('/v1/metrics/summary', { params: { query: { window: '60s' } } })),
    enabled: ticks.length === 0,
  });
  const isAdmin = principal?.role === 'admin';
  const lag = useQuery({
    queryKey: keys.lag,
    queryFn: () => unwrap(api.GET('/admin/consumers/lag')),
    enabled: isAdmin,
    refetchInterval: 10_000,
  });
  const current: Summary | undefined = ticks.at(-1) ?? initial.data;
  const totalLag = lag.data?.items.reduce((sum, i) => sum + BigInt(i.lag), 0n);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-fg">Live monitor</h1>
      <section
        aria-label="Key indicators"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
      >
        <KpiCard
          label="Transactions/s"
          value={current ? current.transactionsPerSecond.toFixed(2) : '—'}
        />
        <KpiCard label="Approve" value={current ? formatPercent(current.rates.approve) : '—'} />
        <KpiCard label="Review" value={current ? formatPercent(current.rates.review) : '—'} />
        <KpiCard label="Decline" value={current ? formatPercent(current.rates.decline) : '—'} />
        <KpiCard
          label="p95 latency"
          value={current?.p95LatencyMs != null ? `${String(current.p95LatencyMs)} ms` : '—'}
        />
        {isAdmin ? (
          <KpiCard
            label="Consumer lag"
            value={totalLag === undefined ? '—' : totalLag.toString()}
            hint="messages, all groups"
          />
        ) : null}
      </section>
      <Card>
        <CardTitle>Last 15 minutes</CardTitle>
        <LiveChart ticks={ticks} />
      </Card>
      <Card className="p-0">
        <CardTitle className="px-4 pt-4">Recent decisions (sampled)</CardTitle>
        <DecisionFeed decisions={feed} />
      </Card>
    </div>
  );
}
