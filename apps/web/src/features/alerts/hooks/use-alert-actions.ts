import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/ui/toast';
import { api, ApiError, unwrap } from '../../../lib/api-client';
import { keys } from '../../../lib/query-keys';
import { session } from '../../../lib/session';
import type { AlertDetail, Verdict } from '../../../lib/types';

/**
 * Assign and resolve with optimistic updates: the detail changes immediately and is rolled
 * back, with an error toast, if the gateway refuses (SPEC §8.2).
 */
export function useAlertActions(alertId: string) {
  const client = useQueryClient();
  const notify = useToast();
  const key = keys.alertDetail(alertId);

  const optimistic = (patch: Partial<AlertDetail>) => async () => {
    await client.cancelQueries({ queryKey: key });
    const previous = client.getQueryData<AlertDetail>(key);
    if (previous) client.setQueryData<AlertDetail>(key, { ...previous, ...patch });
    return { previous };
  };
  const rollback =
    (title: string) =>
    (error: Error, _vars: unknown, ctx?: { previous: AlertDetail | undefined }) => {
      if (ctx?.previous) client.setQueryData(key, ctx.previous);
      const detail =
        error instanceof ApiError && error.status === 409
          ? 'Someone already resolved this alert.'
          : error.message;
      notify({ title, description: detail, tone: 'error' });
    };
  const settle = () => client.invalidateQueries({ queryKey: keys.alerts });

  const assign = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/v1/alerts/{id}/assign', { params: { path: { id: alertId } } })),
    onMutate: optimistic({ status: 'IN_PROGRESS', assignedTo: session.principal?.userId ?? null }),
    onError: rollback('Could not assign the alert'),
    onSettled: settle,
  });

  const resolve = useMutation({
    mutationFn: (v: { verdict: Verdict; note: string }) =>
      unwrap(api.POST('/v1/alerts/{id}/resolve', { params: { path: { id: alertId } }, body: v })),
    onMutate: async (v) =>
      optimistic({ status: v.verdict, resolvedAt: new Date().toISOString() })(),
    onError: rollback('Could not resolve the alert'),
    onSuccess: (_d, v) => {
      notify({
        title: v.verdict === 'CONFIRMED_FRAUD' ? 'Confirmed as fraud' : 'Marked legitimate',
        tone: 'success',
      });
    },
    onSettled: settle,
  });

  return { assign, resolve };
}
