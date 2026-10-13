import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Badge, toneFor } from '../../../components/ui/badge';
import { Card, CardTitle } from '../../../components/ui/card';
import { Table, Td, Th } from '../../../components/ui/table';
import { api, unwrap } from '../../../lib/api-client';
import { formatMoney } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import type { TimelineItem } from '../../../lib/types';

function describe(item: TimelineItem) {
  const p = item.payload;
  if (item.kind === 'DECISION' && 'decision' in p) {
    return (
      <span className="flex items-center gap-2">
        <Badge tone={toneFor(p.decision)}>{p.decision}</Badge>
        <span className="font-mono text-xs">score {p.finalScore.toFixed(4)}</span>
      </span>
    );
  }
  if ('entries' in p) {
    const mine = p.entries.find((e) => e.ledgerAccount.startsWith('customer:'));
    return (
      <span className="flex items-center gap-2">
        <Badge>LEDGER</Badge>
        <span className="text-xs text-fg-muted">
          {mine
            ? `${mine.direction.toLowerCase()} ${formatMoney({ value: mine.amount, currency: mine.currency })}`
            : 'posted'}
        </span>
      </span>
    );
  }
  return null;
}

/** Account Timeline (SPEC §8.2): profile, baseline stats, history and balance. */
export default function AccountPage() {
  const { id = '' } = useParams();
  const view = useQuery({
    queryKey: keys.account(id),
    queryFn: () =>
      unwrap(api.GET('/v1/accounts/{accountId}', { params: { path: { accountId: id } } })),
  });
  const timeline = useQuery({
    queryKey: keys.timeline(id),
    queryFn: () =>
      unwrap(api.GET('/v1/accounts/{accountId}/timeline', { params: { path: { accountId: id } } })),
  });
  const a = view.data;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-fg">Account {id}</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>Profile</CardTitle>
          {a?.profile ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-fg-muted">Home</dt>
              <dd>{[a.profile.homeCity, a.profile.homeCountry].filter(Boolean).join(', ')}</dd>
              <dt className="text-fg-muted">Risk tier</dt>
              <dd>
                <Badge
                  tone={
                    a.profile.riskTier === 'HIGH'
                      ? 'decline'
                      : a.profile.riskTier === 'MEDIUM'
                        ? 'review'
                        : 'approve'
                  }
                >
                  {a.profile.riskTier}
                </Badge>
              </dd>
              <dt className="text-fg-muted">Credit limit</dt>
              <dd>{formatMoney({ value: a.profile.creditLimit, currency: 'BRL' })}</dd>
            </dl>
          ) : (
            <p className="text-sm text-fg-muted">
              {view.isLoading ? 'Loading…' : 'No profile received for this account.'}
            </p>
          )}
        </Card>
        <Card>
          <CardTitle>Balance</CardTitle>
          <p className="text-2xl font-semibold tabular-nums" data-testid="balance">
            {a?.balance
              ? formatMoney({ value: a.balance.balance, currency: a.balance.currency })
              : '—'}
          </p>
          <p className="text-xs text-fg-muted">Ledger postings of approved transactions</p>
        </Card>
        <Card>
          <CardTitle>Recent activity</CardTitle>
          {a ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-fg-muted">Transactions (8 days)</dt>
              <dd>{a.stats.transactions}</dd>
              <dt className="text-fg-muted">Average amount</dt>
              <dd>
                {a.stats.averageAmount
                  ? formatMoney({ value: a.stats.averageAmount, currency: 'BRL' })
                  : '—'}
              </dd>
              <dt className="text-fg-muted">Decisions</dt>
              <dd>
                {a.stats.approve} approve · {a.stats.review} review · {a.stats.decline} decline
              </dd>
              <dt className="text-fg-muted">Open alerts</dt>
              <dd>{a.stats.openAlerts}</dd>
            </dl>
          ) : null}
        </Card>
      </div>

      <h2 className="text-lg font-semibold text-fg">History</h2>
      <Table aria-label="Account history">
        <thead>
          <tr>
            <Th>Time</Th>
            <Th>Event</Th>
            <Th className="text-right">Amount</Th>
            <Th>Transaction</Th>
          </tr>
        </thead>
        <tbody>
          {(timeline.data?.items ?? []).map((item) => (
            <tr
              key={`${item.kind}-${item.transactionId}`}
              data-testid="timeline-row"
              data-kind={item.kind}
            >
              <Td className="whitespace-nowrap text-fg-muted">
                {new Date(item.occurredAt).toLocaleString('en-GB')}
              </Td>
              <Td>{describe(item)}</Td>
              <Td className="text-right tabular-nums">{formatMoney(item.amount)}</Td>
              <Td className="font-mono text-xs text-fg-muted">{item.transactionId.slice(0, 8)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {timeline.data?.items.length === 0 ? (
        <p className="text-sm text-fg-muted">No activity yet.</p>
      ) : null}
      <p className="text-sm">
        <Link
          to={`/alerts?account=${id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          Alerts of this account
        </Link>
      </p>
    </div>
  );
}
