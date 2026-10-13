/** One place for the TanStack Query cache keys the SSE stream writes into. */
export const keys = {
  alerts: ['alerts'] as const,
  alertList: (filters: object) => ['alerts', 'list', filters] as const,
  alertDetail: (id: string) => ['alerts', 'detail', id] as const,
  incomingAlerts: ['alerts', 'incoming'] as const,
  decisionFeed: ['decisions', 'feed'] as const,
  ticks: ['metrics', 'ticks'] as const,
  summary: (window: string) => ['metrics', 'summary', window] as const,
  lag: ['admin', 'lag'] as const,
  account: (id: string) => ['accounts', id] as const,
  timeline: (id: string) => ['accounts', id, 'timeline'] as const,
};
