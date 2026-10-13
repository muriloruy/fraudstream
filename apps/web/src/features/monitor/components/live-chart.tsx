import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Tick } from '../../../lib/event-stream';

const time = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

/** tx/s and decline rate over the last 15 minutes, fed by metrics.tick (SPEC §8.2). */
export function LiveChart({ ticks }: { ticks: readonly Tick[] }) {
  const data = ticks.map((t) => ({
    at: t.at,
    tps: t.transactionsPerSecond,
    decline: Math.round(t.rates.decline * 1000) / 10,
  }));
  return (
    <figure
      aria-label="Transactions per second and decline rate, last 15 minutes"
      className="h-64 w-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" />
          <XAxis
            dataKey="at"
            tickFormatter={time}
            stroke="rgb(var(--color-fg-muted))"
            fontSize={12}
            minTickGap={40}
          />
          <YAxis yAxisId="tps" stroke="rgb(var(--color-fg-muted))" fontSize={12} width={40} />
          <YAxis
            yAxisId="pct"
            orientation="right"
            unit="%"
            stroke="rgb(var(--color-fg-muted))"
            fontSize={12}
            width={44}
          />
          <Tooltip
            labelFormatter={(at) => time(Number(at))}
            contentStyle={{
              background: 'rgb(var(--color-surface))',
              border: '1px solid rgb(var(--color-border))',
            }}
          />
          <Legend />
          <Line
            yAxisId="tps"
            type="monotone"
            dataKey="tps"
            name="tx/s"
            stroke="rgb(var(--color-primary))"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="decline"
            name="decline %"
            stroke="rgb(var(--color-decline))"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </figure>
  );
}
