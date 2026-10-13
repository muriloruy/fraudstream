import type { AlertListItem, AlertStatus } from '../../../lib/types';

export type StatusFilter = 'open' | 'resolved' | 'all';
export type SortOrder = 'score' | 'age';

export interface QueueFilters {
  status: StatusFilter;
  minScore: string;
  accountId: string;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: QueueFilters = {
  status: 'open',
  minScore: '',
  accountId: '',
  sort: 'score',
};

const STATUSES: Record<StatusFilter, AlertStatus[]> = {
  open: ['OPEN', 'IN_PROGRESS'],
  resolved: ['CONFIRMED_FRAUD', 'LEGITIMATE'],
  all: ['OPEN', 'IN_PROGRESS', 'CONFIRMED_FRAUD', 'LEGITIMATE'],
};

export const statusesOf = (f: StatusFilter): AlertStatus[] =>
  f === 'resolved' ? STATUSES.resolved : f === 'all' ? STATUSES.all : STATUSES.open;

/** Query parameters of GET /v1/alerts for the server-side filters. */
export function toQuery(f: QueueFilters, cursor: string | undefined) {
  return {
    status: statusesOf(f.status).join(','),
    ...(f.minScore ? { minScore: f.minScore } : {}),
    ...(f.accountId ? { accountId: f.accountId } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };
}

/** Whether a live alert belongs in the current view (same rules as the server filters). */
export function matches(alert: AlertListItem, f: QueueFilters): boolean {
  if (!statusesOf(f.status).includes(alert.status)) return false;
  if (f.minScore && Number(alert.finalScore) < Number(f.minScore)) return false;
  if (f.accountId && alert.accountId !== f.accountId) return false;
  return true;
}
