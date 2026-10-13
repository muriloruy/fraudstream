import { cn } from '../../lib/cn';

/** Final score as a colored bar against the decision thresholds; the number stays readable. */
export function ScoreBar({
  score,
  approveBelow = 0.4,
  declineFrom = 0.75,
}: {
  score: number;
  approveBelow?: number;
  declineFrom?: number;
}) {
  const tone =
    score >= declineFrom ? 'bg-decline' : score >= approveBelow ? 'bg-review' : 'bg-approve';
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-16 overflow-hidden rounded-full bg-surface-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={score}
        aria-label="Final score"
      >
        <div
          className={cn('h-full rounded-full', tone)}
          style={{ width: `${String(Math.round(score * 100))}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums">{score.toFixed(4)}</span>
    </div>
  );
}
