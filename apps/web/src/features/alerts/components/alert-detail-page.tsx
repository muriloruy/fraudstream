import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, toneFor } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardTitle } from '../../../components/ui/card';
import { api, unwrap } from '../../../lib/api-client';
import { formatMoney } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import type { Verdict } from '../../../lib/types';
import { usePrincipal } from '../../auth/hooks/use-session';
import { useAlertActions } from '../hooks/use-alert-actions';
import { MiniTimeline } from './mini-timeline';
import { ResolveDialog } from './resolve-dialog';
import { ScoreBreakdown } from './score-breakdown';

/** Alert Detail (SPEC §8.2). Opening it writes ALERT_VIEWED to the audit log (gateway). */
export default function AlertDetailPage() {
  const { id = '' } = useParams();
  const principal = usePrincipal();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const detail = useQuery({
    queryKey: keys.alertDetail(id),
    queryFn: () => unwrap(api.GET('/v1/alerts/{id}', { params: { path: { id } } })),
  });
  const accountId = detail.data?.accountId;
  const timeline = useQuery({
    queryKey: keys.timeline(accountId ?? ''),
    queryFn: () =>
      unwrap(
        api.GET('/v1/accounts/{accountId}/timeline', {
          params: { path: { accountId: accountId ?? '' } },
        }),
      ),
    enabled: accountId !== undefined,
  });
  const { assign, resolve } = useAlertActions(id);

  if (detail.isLoading) return <p role="status">Loading alert…</p>;
  if (detail.isError || !detail.data) {
    return (
      <p role="alert" className="text-decline">
        Could not load this alert.
      </p>
    );
  }
  const a = detail.data;
  const tx = a.snapshot.transaction;
  const open = a.status === 'OPEN' || a.status === 'IN_PROGRESS';

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/alerts" className="text-primary underline-offset-2 hover:underline">
          Alerts
        </Link>{' '}
        / {a.accountId}
      </nav>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-fg">Alert for {a.accountId}</h1>
        <Badge tone={toneFor(a.decision)}>{a.decision}</Badge>
        <Badge tone={toneFor(a.status)} data-testid="alert-status">
          {a.status.replace('_', ' ')}
        </Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={!open || a.assignedTo === principal?.userId}
            onClick={() => {
              assign.mutate();
            }}
          >
            Assign to me
          </Button>
          <Button
            variant="danger"
            disabled={!open}
            onClick={() => {
              setVerdict('CONFIRMED_FRAUD');
            }}
          >
            Confirm fraud
          </Button>
          <Button
            variant="success"
            disabled={!open}
            onClick={() => {
              setVerdict('LEGITIMATE');
            }}
          >
            Mark legitimate
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card>
          <CardTitle>Transaction</CardTitle>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-fg-muted">Amount</dt>
            <dd className="font-semibold">{formatMoney(tx.amount)}</dd>
            <dt className="text-fg-muted">Card</dt>
            <dd className="font-mono">{tx.maskedPan}</dd>
            <dt className="text-fg-muted">Merchant</dt>
            <dd>
              {tx.merchant.name} <span className="text-fg-muted">(MCC {tx.merchant.mcc})</span>
            </dd>
            <dt className="text-fg-muted">Location</dt>
            <dd>
              {[tx.merchant.city, tx.merchant.country].filter(Boolean).join(', ')}
              {tx.geo ? (
                <span className="block font-mono text-xs text-fg-muted">
                  {tx.geo.lat.toFixed(4)}, {tx.geo.lon.toFixed(4)}
                </span>
              ) : null}
            </dd>
            <dt className="text-fg-muted">Channel</dt>
            <dd>
              {tx.channel} · {tx.entryMode}
            </dd>
            <dt className="text-fg-muted">Device</dt>
            <dd className="truncate font-mono text-xs" title={tx.deviceIdHash}>
              {tx.deviceIdHash ?? '—'}
            </dd>
            <dt className="text-fg-muted">Requested</dt>
            <dd>{new Date(tx.requestedAt).toLocaleString('en-GB')}</dd>
          </dl>
          <h3 className="mt-4 text-sm font-medium text-fg">Reasons</h3>
          <ul className="mt-1 list-inside list-disc text-sm text-fg-muted">
            {a.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Card>
        <ScoreBreakdown decision={a.snapshot.decision} />
      </div>

      {timeline.data ? (
        <MiniTimeline items={timeline.data.items} current={a.transactionId} />
      ) : null}
      <p className="text-sm">
        <Link
          to={`/accounts/${a.accountId}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          Open the account timeline
        </Link>
      </p>

      <ResolveDialog
        verdict={verdict}
        onClose={() => {
          setVerdict(null);
        }}
        onSubmit={(v) => {
          resolve.mutate(v);
        }}
      />
    </div>
  );
}
