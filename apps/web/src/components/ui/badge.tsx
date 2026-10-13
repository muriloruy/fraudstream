import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const tones = {
  neutral: 'bg-surface-muted text-fg-muted',
  approve: 'bg-approve/15 text-approve',
  review: 'bg-review/15 text-review',
  decline: 'bg-decline/15 text-decline',
  primary: 'bg-primary/15 text-primary',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium leading-none',
        // eslint-disable-next-line security/detect-object-injection -- key is a literal union type
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Badge color by decision or alert status, so colors mean the same everywhere. */
export function toneFor(value: string): BadgeTone {
  switch (value) {
    case 'APPROVE':
    case 'LEGITIMATE':
      return 'approve';
    case 'REVIEW':
    case 'IN_PROGRESS':
      return 'review';
    case 'DECLINE':
    case 'CONFIRMED_FRAUD':
      return 'decline';
    case 'OPEN':
      return 'primary';
    default:
      return 'neutral';
  }
}
