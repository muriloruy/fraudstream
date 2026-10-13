import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardTitle } from '../../../components/ui/card';
import { formatMoney, formatTime } from '../../../lib/format';
import type { TimelineItem } from '../../../lib/types';

/** Last 20 transactions of the account, this one highlighted (SPEC §8.2). */
export function MiniTimeline({
  items,
  current,
}: {
  items: readonly TimelineItem[];
  current: string;
}) {
  const decisions = items
    .filter((i) => i.kind === 'DECISION' && i.amount)
    .slice(0, 20)
    .reverse();
  const data = decisions.map((i) => ({
    id: i.transactionId,
    at: i.occurredAt,
    amount: Number(i.amount?.value ?? 0),
  }));
  return (
    <Card>
      <CardTitle>Account, last {decisions.length} transactions</CardTitle>
      <figure
        className="h-40"
        aria-label="Amounts of the last transactions; the current one is highlighted"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis
              dataKey="at"
              tickFormatter={(at: string) => formatTime(at)}
              fontSize={10}
              stroke="rgb(var(--color-fg-muted))"
            />
            <YAxis fontSize={10} width={48} stroke="rgb(var(--color-fg-muted))" />
            <Tooltip
              formatter={(v) => formatMoney({ value: String(v), currency: 'BRL' })}
              labelFormatter={(label: unknown) =>
                typeof label === 'string' ? formatTime(label) : ''
              }
            />
            <Bar dataKey="amount" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
      <ul className="sr-only">
        {decisions.map((i) => (
          <li key={i.transactionId}>
            {formatTime(i.occurredAt)} {formatMoney(i.amount)}{' '}
            {i.transactionId === current ? '(this alert)' : ''}
          </li>
        ))}
      </ul>
    </Card>
  );
}
