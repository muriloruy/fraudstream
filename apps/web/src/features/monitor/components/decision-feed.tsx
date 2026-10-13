import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Badge, toneFor } from '../../../components/ui/badge';
import { formatTime } from '../../../lib/format';
import type { DecisionMade } from '../../../lib/types';

const ROW = 40;

/** Last 200 sampled decisions, virtualized: only visible rows are in the DOM (SPEC §8.2). */
export function DecisionFeed({ decisions }: { decisions: readonly DecisionMade[] }) {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: decisions.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW,
    overscan: 8,
    initialRect: { width: 600, height: 400 }, // first paint (and tests) before measuring
  });
  if (decisions.length === 0) {
    return <p className="p-4 text-sm text-fg-muted">Waiting for decisions…</p>;
  }
  return (
    // A scrollable region must be reachable by keyboard to be scrolled (WCAG 2.1.1).
    <div
      ref={parent}
      className="h-96 overflow-auto"
      role="region"
      aria-label="Recent decisions"
      tabIndex={0}
    >
      <div role="list" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const d = decisions[row.index];
          if (!d) return null;
          return (
            <div
              key={d.transactionId}
              role="listitem"
              className="absolute left-0 flex w-full items-center gap-3 border-b border-border px-2 text-sm"
              style={{ height: ROW, transform: `translateY(${String(row.start)}px)` }}
            >
              <span className="w-20 font-mono text-xs text-fg-muted">
                {formatTime(d.decidedAt)}
              </span>
              <Badge tone={toneFor(d.decision)} className="w-20 justify-center">
                {d.decision}
              </Badge>
              <Link
                to={`/accounts/${d.accountId}`}
                className="truncate text-primary underline-offset-2 hover:underline"
              >
                {d.accountId}
              </Link>
              <span className="ml-auto font-mono text-xs tabular-nums">
                {d.finalScore.toFixed(4)}
              </span>
              <span className="w-16 text-right text-xs text-fg-muted">{d.latencyMs} ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
