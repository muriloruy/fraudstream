import type { components, paths } from './api-types';

type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;

export type LoginResponse = Ok<'/auth/login', 'post'>;
export type Principal = LoginResponse['user'];
export type AlertPage = Ok<'/v1/alerts', 'get'>;
export type AlertListItem = AlertPage['items'][number];
export type AlertDetail = Ok<'/v1/alerts/{id}', 'get'>;
export type AlertStatus = AlertListItem['status'];
export type Timeline = Ok<'/v1/accounts/{accountId}/timeline', 'get'>;
export type TimelineItem = Timeline['items'][number];
export type AccountView = Ok<'/v1/accounts/{accountId}', 'get'>;
export type Summary = Ok<'/v1/metrics/summary', 'get'>;
export type LagResponse = Ok<'/admin/consumers/lag', 'get'>;
export type DecisionMade = components['schemas']['StreamEvent_decision_made'];
export type Verdict = 'CONFIRMED_FRAUD' | 'LEGITIMATE';
