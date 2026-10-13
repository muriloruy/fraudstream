import { Card, CardTitle } from '../../../components/ui/card';
import type { AlertDetail } from '../../../lib/types';

type Decision = AlertDetail['snapshot']['decision'];

const pct = (x: number) => `${String(Math.round(x * 100))}%`;

/** Rule points, anomaly features, weights and the final score against the thresholds (SPEC §8.2). */
export function ScoreBreakdown({ decision }: { decision: Decision }) {
  const b = decision.breakdown;
  const approveBelow = b?.thresholds.approveBelow ?? 0.4;
  const declineFrom = b?.thresholds.declineFrom ?? 0.75;
  const maxPoints = Math.max(1, ...(b?.firedRules.map((r) => r.points) ?? []));
  return (
    <Card>
      <CardTitle>Score breakdown</CardTitle>

      <div className="mb-5">
        <h3 className="mb-2 text-sm font-medium text-fg">Final score vs thresholds</h3>
        <div
          className="relative h-6 rounded-full bg-surface-muted"
          role="img"
          aria-label={`Final score ${decision.finalScore.toFixed(4)}; approve below ${String(approveBelow)}, decline from ${String(declineFrom)}`}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-l-full bg-approve/25"
            style={{ width: pct(approveBelow) }}
          />
          <div
            className="absolute inset-y-0 bg-review/25"
            style={{ left: pct(approveBelow), width: pct(declineFrom - approveBelow) }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-r-full bg-decline/25"
            style={{ width: pct(1 - declineFrom) }}
          />
          <div
            className="absolute -top-1 h-8 w-1 rounded bg-fg"
            style={{ left: `calc(${pct(decision.finalScore)} - 2px)` }}
          />
        </div>
        <p className="mt-1 flex justify-between text-xs text-fg-muted">
          <span>approve &lt; {approveBelow}</span>
          <span className="font-mono text-fg">{decision.finalScore.toFixed(4)}</span>
          <span>decline ≥ {declineFrom}</span>
        </p>
      </div>

      <dl className="mb-5 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-fg-muted">Rule score</dt>
          <dd className="font-mono">{decision.components.ruleScore?.toFixed(4) ?? 'timed out'}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Anomaly score</dt>
          <dd className="font-mono">
            {decision.components.anomalyScore?.toFixed(4) ?? 'timed out'}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Weights</dt>
          <dd className="font-mono">
            {b ? `rules ${pct(b.weights.rules)} · anomaly ${pct(b.weights.anomaly)}` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Decided in</dt>
          <dd className="font-mono">{decision.latencyMs} ms</dd>
        </div>
      </dl>

      <h3 className="mb-2 text-sm font-medium text-fg">Rule points</h3>
      {b && b.firedRules.length > 0 ? (
        <ul className="mb-5 flex flex-col gap-2" aria-label="Fired rules">
          {b.firedRules.map((r) => (
            <li
              key={r.ruleId}
              className="grid grid-cols-[5rem_1fr_3rem] items-center gap-2 text-sm"
            >
              <span className="font-mono text-xs">{r.ruleId}</span>
              <span className="flex items-center gap-2">
                <span
                  className="h-3 rounded bg-primary"
                  style={{ width: pct(r.points / maxPoints) }}
                  aria-hidden
                />
                <span className="truncate text-fg-muted">{r.name}</span>
              </span>
              <span className="text-right font-mono tabular-nums">{r.points}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-5 text-sm text-fg-muted">No rule fired.</p>
      )}

      <h3 className="mb-2 text-sm font-medium text-fg">Anomaly features</h3>
      {b?.anomaly ? (
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-fg-muted">Amount z</dt>
            <dd className="font-mono">{b.anomaly.features.amountZ.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Inter-arrival z</dt>
            <dd className="font-mono">{b.anomaly.features.interArrivalZ.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Hour deviation</dt>
            <dd className="font-mono">{b.anomaly.features.hourOfDayDeviation.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">New merchant</dt>
            <dd>{b.anomaly.features.newMerchant ? 'yes' : 'no'}</dd>
          </div>
          <p className="col-span-full text-xs text-fg-muted">
            Baseline of {b.anomaly.baselineSampleSize} transactions · model {b.anomaly.modelVersion}
          </p>
        </dl>
      ) : (
        <p className="text-sm text-fg-muted">Anomaly score not available for this decision.</p>
      )}
    </Card>
  );
}
