import { useQuery, type QueryKey } from '@tanstack/react-query';

/**
 * Subscribes to a cache entry that only the SSE stream writes (no fetching): the component
 * re-renders whenever applyStreamEvent updates it.
 */
export function useCacheValue<T>(key: QueryKey, initial: T): T {
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? initial;
}
